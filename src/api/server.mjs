#!/usr/bin/env node

import express from "express";
import QRCode from "qrcode";
import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  consumeRecoveryCode,
  createApiKey,
  createBuild,
  createInvite,
  createNotification,
  createRecoveryCodes,
  createSession,
  createSignupRequest,
  createUser,
  decideSignupRequest,
  deleteApiKey,
  deleteInvite,
  deleteRecoveryCodesForUser,
  deleteSessionByTokenHash,
  disableApiKey,
  disableArtifactDownloadTokenForArtifact,
  disableUserTotp,
  enableUserTotp,
  getActiveInviteByTokenHash,
  getApiKeyByHash,
  getApiKeyById,
  getAppMeta,
  getArtifactDownloadToken,
  getArtifactsForBuild,
  getBuild,
  getBuildMetrics,
  getSessionWithUser,
  getSignupRequestById,
  getTotalBuildCount,
  getUserById,
  getUserByUsername,
  listApiKeysForUser,
  listBuilds,
  listInvites,
  listSignupRequests,
  listUnreadNotificationsForUser,
  listUsers,
  markInviteUsed,
  markNotificationRead,
  recordUserLogin,
  setUserEnabled,
  setUserRole,
  updateUserPassword,
  upsertAppMeta,
} from "../db/database.mjs";
import { createLogger } from "../logging/logger.mjs";
import { serializeJobForQueue } from "../queue/jobPayload.mjs";
import { cancelQueuedBuild, processQueue, queueState } from "../queue/queue.mjs";
import { reconstructQueueOnStartup } from "../queue/recovery.mjs";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
} from "../security/cookies.mjs";
import { hashPassword, MIN_PASSWORD_LENGTH, validatePasswordLength, verifyPassword } from "../security/passwords.mjs";
import { checkAndConsume } from "../security/rateLimit.mjs";
import { encryptSecrets } from "../security/secrets.mjs";
import { KNOWN_SCOPES, hasScope, parseScopes, serializeScopes } from "../security/scopes.mjs";
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from "../security/totp.mjs";
import { runBackup } from "../system/backup.mjs";
import { tailApiLog } from "../system/logs.mjs";
import { checkLatestVersion, triggerUpdate } from "../system/update.mjs";

const logger = createLogger("api");
const app = express();

// Needed for req.ip to reflect the real client address (not Caddy's own
// LAN IP) behind the reverse proxy this project always assumes — without
// it, every request behind the proxy would share one rate-limit bucket.
app.set("trust proxy", true);

const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const secretsKey = process.env.JOB_SECRETS_ENCRYPTION_KEY;

const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const { version: appVersion } = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Fail fast at startup rather than on the first build submission.
try {
  encryptSecrets({}, secretsKey);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Real HTTP auth (username/password + mandatory TOTP), separate from API
// keys — session cookie config. Secure defaults on (production is always
// HTTPS per the security baseline); COOKIE_SECURE=false is only for local
// http://localhost dev, where a browser silently refuses to store a
// Secure cookie at all.
const cookieSecure = process.env.COOKIE_SECURE !== "false";
const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS ?? 12);

// Derived from the existing secrets key rather than provisioning a second
// one — only used to HMAC-sign the stateless, no-DB-row request-access
// math challenge so it can't be forged or replayed with a different
// answer.
const requestAccessHmacKey = createHash("sha256").update(`request-access:${secretsKey}`).digest();

function signRequestAccessChallenge(a, b, renderedAt) {
  return createHmac("sha256", requestAccessHmacKey).update(`${a}:${b}:${renderedAt}`).digest("hex");
}

// Short-lived, in-memory state for the login->MFA and signup/first-
// login->2FA-enrollment handshakes. A restart mid-step just means
// retrying that one step — documented tradeoff, same as the rate
// limiter (src/security/rateLimit.mjs).
const pendingLogins = new Map();
const pendingEnrollments = new Map();

function issueSession(user) {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionTtlHours * 3600 * 1000);

  createSession({
    tokenHash,
    userId: user.id,
    csrfToken,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return {
    cookie: buildSessionCookie(rawToken, { secure: cookieSecure, maxAgeSeconds: sessionTtlHours * 3600 }),
    csrfToken,
  };
}

// Best-effort — an admin still gets the raw token back either way
// (nothing here fails), but a shareable link needs a known web UI
// origin to build from.
function buildInviteLink(token, purpose) {
  const origin = allowedOrigins[0];

  if (!origin) {
    return null;
  }

  const path = purpose === "password_reset" ? "password-reset" : "signup";
  return `${origin}/#/${path}?token=${token}`;
}

// The web UI (web/) is typically served from its own Caddy site, a
// different origin than this API — restricted to explicitly-known
// origins (WEB_UI_ORIGIN), never a wide-open wildcard, per the project's
// security baseline. Empty/unset means no cross-origin access at all.
const allowedOrigins = (process.env.WEB_UI_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get("origin");

  if (origin && allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-CSRF-Token");
    res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    // Needed for the session cookie (real HTTP auth, separate from API
    // keys) to actually be sent/stored cross-origin — never paired with a
    // wildcard origin above, which browsers refuse anyway once
    // credentials are involved.
    res.set("Access-Control-Allow-Credentials", "true");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

// Resolves the acting principal from either a session cookie (real HTTP
// auth — username/password + mandatory TOTP, separate from API keys) or
// a Bearer API key, and sets req.user/req.apiKey/req.authMethod
// uniformly so everything downstream (scopes, build ownership) checks
// one consistent shape regardless of which auth method was used.
//
// A session is implicitly granted the full non-admin permission set for
// its own workspace (see requireScope below) — narrowing access to a
// subset of actions is what API keys are for, not sessions. CSRF
// protection lives here too: the session cookie is httpOnly, so the
// client can't read it to echo back automatically the way a
// synchronizer token normally would — instead the token is handed back
// in the login/enroll response body and must be echoed as
// X-CSRF-Token on every mutating request.
function authenticate(req, res, next) {
  const cookies = parseCookieHeader(req.get("cookie"));
  const sessionToken = cookies[SESSION_COOKIE_NAME];

  if (sessionToken) {
    const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
    const session = getSessionWithUser(tokenHash);

    if (session && session.userEnabled && new Date(session.expiresAt) > new Date()) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const csrfHeader = req.get("x-csrf-token");

        if (!csrfHeader || csrfHeader !== session.csrfToken) {
          return res.status(403).json({
            error: "Missing or invalid CSRF token.",
          });
        }
      }

      req.user = { id: session.userId, username: session.username, role: session.role };
      req.authMethod = "session";
      req.sessionTokenHash = tokenHash;
      // Stashed so /api/v1/whoami can hand it back out — the client only
      // ever receives this once, at login, and has nowhere durable to
      // keep it (it's deliberately not in the cookie, which is httpOnly).
      // Re-fetching it via whoami on page load is what lets a signed-in
      // session survive a refresh without forcing a fresh login.
      req.sessionCsrfToken = session.csrfToken;

      return next();
    }
  }

  const authorization = req.get("authorization");

  if (!authorization) {
    return res.status(401).json({
      error: "Authentication required.",
    });
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Invalid authorization header.",
    });
  }

  const suppliedKey = match[1];

  const keyHash = createHash("sha256")
    .update(suppliedKey)
    .digest("hex");

  const apiKey = getApiKeyByHash(keyHash);

  if (!apiKey) {
    return res.status(401).json({
      error: "Invalid API key.",
    });
  }

  req.apiKey = {
    id: apiKey.id,
    name: apiKey.name,
    scopes: parseScopes(apiKey.scopes),
  };
  req.authMethod = "apiKey";

  // Legacy (pre-v2.0.0) keys were never issued to a user — null here
  // preserves their exact prior unowned behavior (see database.mjs's
  // listBuilds/requireBuildAccess below), not a bug to "fix" later.
  const owner = apiKey.userId != null ? getUserById(apiKey.userId) : null;
  req.user = owner ? { id: owner.id, username: owner.username, role: owner.role } : null;

  next();
}

function hasEffectiveScope(req, scope) {
  // A session isn't scope-narrowed — it's the human's own full access to
  // their own workspace. Only Bearer API keys carry a restrictable scope
  // set (KNOWN_SCOPES no longer includes any admin-level action at all;
  // those are pure requireAdmin/requireSessionOnly checks below, never
  // satisfiable via a key).
  return req.authMethod === "session" || hasScope(req.apiKey, scope);
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!hasEffectiveScope(req, scope)) {
      return res.status(403).json({
        error: `API key missing required scope: ${scope}`,
      });
    }

    next();
  };
}

// Session+role only — deliberately never satisfiable via a Bearer key,
// even one owned by an admin user, so a leaked CI key can never trigger
// a server update, back up, or manage accounts.
function requireAdmin(req, res, next) {
  if (req.authMethod !== "session" || req.user?.role !== "admin") {
    return res.status(403).json({
      error: "Admin sign-in required.",
    });
  }

  next();
}

// API keys live in a user's own profile now — creating/listing/revoking
// them is a session-only action, not something an existing key can do
// for itself (no more bootstrapping more keys from a key).
function requireSessionOnly(req, res, next) {
  if (req.authMethod !== "session") {
    return res.status(403).json({
      error: "This action requires being signed in (not an API key).",
    });
  }

  next();
}

// Combines the scope check with build ownership. Absolute isolation, no
// admin bypass: a mismatch on either side is a 404, not a 403, to avoid
// confirming a build ID exists. The one exception is a fully legacy pair
// (a build with no recorded owner, accessed by a key with no owner) —
// that keeps comparing api_key_id exactly like pre-v2.0.0 did, since
// neither side has a user_id to compare instead.
function requireBuildAccess(scope) {
  return (req, res, next) => {
    if (!hasEffectiveScope(req, scope)) {
      return res.status(403).json({
        error: `API key missing required scope: ${scope}`,
      });
    }

    const build = getBuild(req.params.id);

    if (!build) {
      return res.status(404).json({
        error: "Build not found.",
      });
    }

    const legacyBothSides = build.userId == null && req.user == null;

    if (legacyBothSides) {
      if (build.apiKeyId != null && build.apiKeyId !== req.apiKey.id) {
        return res.status(404).json({
          error: "Build not found.",
        });
      }
    } else if (build.userId !== (req.user?.id ?? null)) {
      return res.status(404).json({
        error: "Build not found.",
      });
    }

    req.build = build;
    next();
  };
}

function createBuildId() {
  return `bld_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function sanitizeBuildForResponse(build) {
  return {
    id: build.id,
    projectName: build.projectName ?? null,
    status: build.status,
    submittedAt: build.submittedAt,
    startedAt: build.startedAt ?? null,
    completedAt: build.completedAt ?? null,
    exitCode: build.exitCode ?? null,
    error: build.error ?? null,
    platform: build.platform ?? null,
    variant: build.variant ?? null,
    artifactType: build.artifactType ?? null,
    failureReason: build.failureReason ?? null,
    cancellationState: build.cancellationState ?? null,
  };
}

// getUserById's row includes passwordHash/totpSecret for internal use
// (verifying login, etc.) — never send those back over the wire.
function sanitizeUserForResponse(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: Boolean(user.enabled),
    totpEnabled: Boolean(user.totpEnabled),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

app.get("/health", (req, res) => {
  const checks = { database: "ok", docker: "ok" };
  let healthy = true;

  try {
    getBuild("__healthcheck__");
  } catch (error) {
    checks.database = `error: ${error.message}`;
    healthy = false;
  }

  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
  } catch (error) {
    checks.docker = `error: ${error.message}`;
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "build-server",
    activeBuild: queueState.activeBuild,
    queuedBuilds: queueState.buildQueue.length,
    checks,
  });
});

// --- Public auth/signup/request-access routes ---
// Registered before the blanket `authenticate` middleware below, the
// same way /health already skips auth — Express dispatches to whichever
// handler was registered first for a matching path, so none of these
// ever reach `authenticate` at all.

app.post("/api/v1/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required." });
  }

  if (
    !checkAndConsume(`login-ip:${req.ip}`, { max: 20, windowMs: 15 * 60 * 1000 }) ||
    !checkAndConsume(`login-user:${username.toLowerCase()}`, { max: 5, windowMs: 15 * 60 * 1000 })
  ) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const user = getUserByUsername(username);

  if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  // Not yet enrolled (a brand-new CLI-bootstrapped admin, or a reset-2fa
  // account) — route straight into enrollment instead of asking for a
  // TOTP code that can't exist yet. Same enroll/start+confirm endpoints
  // an invited signup uses.
  if (!user.totpEnabled) {
    const enrollmentToken = randomBytes(32).toString("hex");
    pendingEnrollments.set(enrollmentToken, {
      userId: user.id,
      secret: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return res.json({ needsEnrollment: true, enrollmentToken });
  }

  const mfaToken = randomBytes(32).toString("hex");
  pendingLogins.set(mfaToken, { userId: user.id, expiresAt: Date.now() + 2 * 60 * 1000 });

  return res.json({ mfaToken });
});

app.post("/api/v1/auth/login/mfa", (req, res) => {
  const { mfaToken, code } = req.body ?? {};

  if (!mfaToken || !code) {
    return res.status(400).json({ error: "mfaToken and code are required." });
  }

  if (!checkAndConsume(`mfa:${req.ip}`, { max: 20, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const pending = pendingLogins.get(mfaToken);

  if (!pending || pending.expiresAt < Date.now()) {
    pendingLogins.delete(mfaToken);
    return res.status(410).json({ error: "Login expired — please sign in again." });
  }

  const user = getUserById(pending.userId);

  if (!user || !user.enabled) {
    pendingLogins.delete(mfaToken);
    return res.status(401).json({ error: "Account no longer available." });
  }

  const validTotp = verifyTotpCode(user.totpSecret, code);
  const validRecovery = !validTotp && consumeRecoveryCode(user.id, hashRecoveryCode(code));

  if (!validTotp && !validRecovery) {
    return res.status(401).json({ error: "Invalid code." });
  }

  pendingLogins.delete(mfaToken);
  recordUserLogin(user.id);

  const session = issueSession(user);
  res.set("Set-Cookie", session.cookie);

  return res.json({
    user: { id: user.id, username: user.username, role: user.role },
    csrfToken: session.csrfToken,
  });
});

app.get("/api/v1/auth/invites/:token", (req, res) => {
  const tokenHash = createHash("sha256").update(req.params.token).digest("hex");
  const invite = getActiveInviteByTokenHash(tokenHash, new Date().toISOString());

  if (!invite) {
    return res.status(404).json({ error: "Invite not found or expired." });
  }

  return res.json({
    purpose: invite.purpose,
    role: invite.role,
    suggestedUsername: invite.suggestedUsername,
  });
});

app.post("/api/v1/auth/invites/:token/complete", (req, res) => {
  const tokenHash = createHash("sha256").update(req.params.token).digest("hex");
  const invite = getActiveInviteByTokenHash(tokenHash, new Date().toISOString());

  if (!invite) {
    return res.status(404).json({ error: "Invite not found or expired." });
  }

  const { password } = req.body ?? {};

  if (!validatePasswordLength(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  if (invite.purpose === "password_reset") {
    updateUserPassword(invite.targetUserId, hashPassword(password));
    markInviteUsed(invite.id);
    return res.json({ ok: true });
  }

  // purpose === "signup"
  const requestedUsername = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const username = invite.suggestedUsername || requestedUsername;

  if (!username) {
    return res.status(400).json({ error: "username is required." });
  }

  if (getUserByUsername(username)) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  const result = createUser({
    username,
    passwordHash: hashPassword(password),
    role: invite.role,
    createdAt: new Date().toISOString(),
  });

  markInviteUsed(invite.id);

  const enrollmentToken = randomBytes(32).toString("hex");
  pendingEnrollments.set(enrollmentToken, {
    userId: result.lastInsertRowid,
    secret: null,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  return res.status(201).json({ enrollmentToken });
});

// Accepts only an enrollmentToken for now (the invite-signup and
// first-login paths above) — a profile page's session-based "regenerate
// 2FA" is a Phase D addition to these same two endpoints, not built yet.
app.post("/api/v1/auth/enroll/start", async (req, res) => {
  const { enrollmentToken } = req.body ?? {};
  const pending = enrollmentToken && pendingEnrollments.get(enrollmentToken);

  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(410).json({ error: "Enrollment link expired — please sign in again." });
  }

  const user = getUserById(pending.userId);

  if (!user) {
    pendingEnrollments.delete(enrollmentToken);
    return res.status(404).json({ error: "Account not found." });
  }

  const secret = generateTotpSecret();
  pending.secret = secret;

  const qrCodeDataUrl = await QRCode.toDataURL(buildOtpauthUri(secret, user.username));

  return res.json({ secret, qrCodeDataUrl });
});

app.post("/api/v1/auth/enroll/confirm", (req, res) => {
  const { enrollmentToken, code } = req.body ?? {};
  const pending = enrollmentToken && pendingEnrollments.get(enrollmentToken);

  if (!pending || pending.expiresAt < Date.now() || !pending.secret) {
    return res.status(410).json({ error: "Enrollment link expired or not started — please sign in again." });
  }

  if (!verifyTotpCode(pending.secret, code)) {
    return res.status(401).json({ error: "Invalid code." });
  }

  enableUserTotp(pending.userId, pending.secret);

  const recoveryCodes = generateRecoveryCodes();
  deleteRecoveryCodesForUser(pending.userId);
  createRecoveryCodes(pending.userId, recoveryCodes.map(hashRecoveryCode), new Date().toISOString());

  pendingEnrollments.delete(enrollmentToken);

  const user = getUserById(pending.userId);
  recordUserLogin(user.id);

  const session = issueSession(user);
  res.set("Set-Cookie", session.cookie);

  return res.status(201).json({
    user: { id: user.id, username: user.username, role: user.role },
    csrfToken: session.csrfToken,
    recoveryCodes,
  });
});

// Stateless (no DB row, no cleanup needed): the answer and issue time are
// embedded in the signed challengeId itself, so request-access below can
// verify it without ever having stored it.
app.get("/api/v1/request-access/challenge", (req, res) => {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const renderedAt = Date.now();
  const signature = signRequestAccessChallenge(a, b, renderedAt);

  return res.json({ challengeId: `${a}.${b}.${renderedAt}.${signature}`, question: `${a} + ${b}` });
});

// Bot resistance without an external CAPTCHA service: a honeypot field
// real users never fill in, a minimum dwell time between fetching the
// challenge and submitting (bots that skip rendering submit instantly),
// and the signed arithmetic challenge above. None of this is bulletproof
// — it's "good enough for a low-profile internal tool," not a claim of
// enterprise-grade bot defense. A bot-shaped submission is silently
// accepted (never inserted) so there's no oracle telling a script which
// check it tripped.
app.post("/api/v1/request-access", (req, res) => {
  if (!checkAndConsume(`request-access:${req.ip}`, { max: 5, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  const { username, email, message, honeypot, challengeId, answer } = req.body ?? {};

  const acknowledge = () => res.status(202).json({
    ok: true,
    message: "Your request has been submitted. An admin will review it.",
  });

  if (honeypot) {
    return acknowledge();
  }

  if (!username || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ error: "username is required." });
  }

  const parts = typeof challengeId === "string" ? challengeId.split(".") : [];

  if (parts.length !== 4) {
    return res.status(400).json({ error: "Invalid or missing challenge." });
  }

  const [aStr, bStr, renderedAtStr, signature] = parts;

  if (signRequestAccessChallenge(aStr, bStr, renderedAtStr) !== signature) {
    return res.status(400).json({ error: "Invalid or missing challenge." });
  }

  if (Number(answer) !== Number(aStr) + Number(bStr)) {
    return res.status(400).json({ error: "Incorrect answer, please try again." });
  }

  // Checked only once the answer is confirmed correct — a bot dumb
  // enough to guess wrong already gets a real error above; this
  // specifically catches one that solved the challenge programmatically
  // but submitted unnaturally fast.
  if (Date.now() - Number(renderedAtStr) < 3000) {
    return acknowledge();
  }

  createSignupRequest({
    requestedUsername: username.trim(),
    email: typeof email === "string" && email.trim() ? email.trim() : null,
    message: typeof message === "string" ? message.trim().slice(0, 1000) : null,
    ipAddress: req.ip,
    createdAt: new Date().toISOString(),
  });

  return acknowledge();
});

app.use("/api/v1", authenticate);

app.post("/api/v1/auth/logout", (req, res) => {
  if (req.authMethod === "session") {
    deleteSessionByTokenHash(req.sessionTokenHash);
  }

  res.set("Set-Cookie", buildClearedSessionCookie({ secure: cookieSecure }));
  return res.status(204).send();
});

// Any valid session or key — lets the web UI's sign-in confirm without
// assuming any particular role/scope.
app.get("/api/v1/whoami", (req, res) => {
  if (req.authMethod === "session") {
    return res.json({
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      authMethod: "session",
      // Lets the web UI re-establish its CSRF token after a page reload
      // without a fresh login — see the comment in authenticate() above.
      csrfToken: req.sessionCsrfToken,
    });
  }

  return res.json({
    id: req.apiKey.id,
    name: req.apiKey.name,
    scopes: req.apiKey.scopes,
    authMethod: "apiKey",
  });
});

app.post("/api/v1/builds", requireScope("build:create"), (req, res) => {
  const job = req.body;

  if (!job || typeof job !== "object" || Array.isArray(job)) {
    return res.status(400).json({
      error: "Request body must be a JSON object.",
    });
  }

  if (!job.project?.name) {
    return res.status(400).json({
      error: "project.name is required.",
    });
  }

  const id = createBuildId();
  const submittedAt = new Date().toISOString();

  const workerJob = {
    ...job,
    id,
  };

  const build = {
    id,
    status: "queued",
    submittedAt,
    job: workerJob,
  };

  queueState.builds.set(id, build);

  createBuild({
    id,
    projectName: job.project.name,
    submittedAt,
    jobPayload: serializeJobForQueue(workerJob, secretsKey),
    platform: job.build?.platform ?? null,
    variant: job.build?.variant ?? null,
    artifactType: job.build?.artifact ?? null,
    apiKeyId: req.authMethod === "apiKey" ? req.apiKey.id : null,
    userId: req.user?.id ?? null,
    submittedBy: req.authMethod === "session" ? req.user.username : req.apiKey.name,
  });

  queueState.buildQueue.push(id);

  logger.info("Build queued", { id });

  processQueue();

  return res.status(202).json({
    id,
    status: build.status,
  });
});

app.get("/api/v1/builds", requireScope("build:read"), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const builds = listBuilds({
    userId: req.user?.id ?? null,
    apiKeyId: req.authMethod === "apiKey" ? req.apiKey.id : null,
    limit,
    offset,
  }).map(sanitizeBuildForResponse);

  return res.json({ builds, limit, offset });
});

app.get("/api/v1/builds/:id", requireBuildAccess("build:read"), (req, res) => {
  return res.json(sanitizeBuildForResponse(req.build));
});

app.get("/api/v1/builds/:id/logs", requireBuildAccess("build:logs"), (req, res) => {
  const logPath = resolve(
    process.cwd(),
    "builds",
    req.params.id,
    "logs",
    "build.log",
  );

  if (!existsSync(logPath)) {
    return res.json({
      id: req.params.id,
      logs: "",
    });
  }

  const logs = readFileSync(logPath, "utf8");

  return res.type("text/plain").send(logs);
});

app.get("/api/v1/builds/:id/artifacts", requireBuildAccess("artifact:download"), (req, res) => {
  const artifacts = getArtifactsForBuild(req.build.id).map((artifact) => ({
    filename: artifact.filename,
    size: artifact.size,
    downloadUrl: `${publicBaseUrl}/download/${artifact.downloadToken}/${encodeURIComponent(artifact.filename)}`,
  }));

  return res.json({
    id: req.build.id,
    artifacts,
  });
});

app.delete(
  "/api/v1/builds/:id/artifacts/:filename/download-token",
  requireBuildAccess("artifact:manage"),
  (req, res) => {
    disableArtifactDownloadTokenForArtifact({
      buildId: req.build.id,
      filename: req.params.filename,
    });

    return res.json({
      id: req.build.id,
      filename: req.params.filename,
      downloadTokenEnabled: false,
    });
  },
);

app.post("/api/v1/builds/:id/cancel", requireBuildAccess("build:cancel"), (req, res) => {
  const build = req.build;

  if (["completed", "failed", "cancelled"].includes(build.status)) {
    return res.status(409).json({
      error: `Build already ${build.status}.`,
    });
  }

  if (cancelQueuedBuild(build.id)) {
    logger.info("Build cancelled (was queued)", { id: build.id });
    return res.json({ id: build.id, status: "cancelled" });
  }

  if (!build.platform) {
    return res.status(409).json({
      error: "Cannot determine the build's container to cancel it.",
    });
  }

  queueState.cancelling.add(build.id);

  try {
    execFileSync("docker", ["kill", `build-${build.platform}-${build.id}`], {
      stdio: "ignore",
    });
  } catch (error) {
    queueState.cancelling.delete(build.id);

    return res.status(500).json({
      error: `Failed to cancel build: ${error.message}`,
    });
  }

  return res.json({ id: build.id, status: "cancelling" });
});

app.get("/api/v1/builds/:id/artifacts/:filename", requireBuildAccess("artifact:download"), (req, res) => {
  const artifactsDir = resolve(
    process.cwd(),
    "builds",
    req.params.id,
    "artifacts",
  );

  const filename = req.params.filename;

  // Only allow a simple filename, never a path.
  if (
    filename !== filename.split("/").pop() ||
    filename !== filename.split("\\").pop() ||
    filename.includes("..")
  ) {
    return res.status(400).json({
      error: "Invalid artifact filename.",
    });
  }

  const artifactPath = resolve(
    artifactsDir,
    filename,
  );

  if (!existsSync(artifactPath)) {
    return res.status(404).json({
      error: "Artifact not found.",
    });
  }

  const stats = statSync(artifactPath);

  if (!stats.isFile()) {
    return res.status(404).json({
      error: "Artifact not found.",
    });
  }

  return res.download(
    artifactPath,
    filename,
  );
});

// API keys live in a user's own profile now — session-only, always
// scoped to req.user.id, never usable by an existing key to mint more
// keys for itself (see requireSessionOnly above).
app.post("/api/v1/api-keys", requireSessionOnly, (req, res) => {
  const { name, scopes } = req.body ?? {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({
      error: "name is required.",
    });
  }

  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
      return res.status(400).json({
        error: "scopes must be an array of strings, or omitted for full access.",
      });
    }

    const unknown = scopes.filter((scope) => !KNOWN_SCOPES.includes(scope));

    if (unknown.length > 0) {
      return res.status(400).json({
        error: `Unknown scope(s): ${unknown.join(", ")}`,
      });
    }
  }

  const key = `abs_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");

  const result = createApiKey({
    name,
    keyHash,
    createdAt: new Date().toISOString(),
    scopes: serializeScopes(scopes),
    userId: req.user.id,
  });

  return res.status(201).json({
    id: result.lastInsertRowid,
    name,
    scopes: scopes ?? null,
    key,
  });
});

app.get("/api/v1/api-keys", requireSessionOnly, (req, res) => {
  const keys = listApiKeysForUser(req.user.id).map((key) => ({
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    enabled: Boolean(key.enabled),
    scopes: parseScopes(key.scopes),
  }));

  return res.json({ apiKeys: keys });
});

app.delete("/api/v1/api-keys/:id", requireSessionOnly, (req, res) => {
  const key = getApiKeyById(Number(req.params.id));

  // Not found AND not-yours both 404, to avoid confirming another
  // user's key id exists.
  if (!key || key.userId !== req.user.id) {
    return res.status(404).json({
      error: "API key not found.",
    });
  }

  disableApiKey(key.id);

  return res.json({ id: key.id, enabled: false });
});

// Permanently removes an already-revoked key's row — gated on it
// already being disabled so there's no path to destroying a still-active
// credential without revoking it first (and losing whatever audit value
// its row still has while active).
app.delete("/api/v1/api-keys/:id/purge", requireSessionOnly, (req, res) => {
  const key = getApiKeyById(Number(req.params.id));

  if (!key || key.userId !== req.user.id) {
    return res.status(404).json({
      error: "API key not found.",
    });
  }

  if (key.enabled) {
    return res.status(409).json({
      error: "Revoke this key before deleting it.",
    });
  }

  deleteApiKey(key.id);

  return res.status(204).send();
});

// Change your own password — requires re-entering the current one, same
// safety bar as any other "prove it's really you" action.
app.post("/api/v1/me/password", requireSessionOnly, (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  const user = getUserById(req.user.id);

  if (!verifyPassword(currentPassword ?? "", user.passwordHash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  if (!validatePasswordLength(newPassword)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  updateUserPassword(user.id, hashPassword(newPassword));

  return res.json({ ok: true });
});

// Regenerates recovery codes without re-scanning a QR code (the TOTP
// secret itself is untouched) — old codes (used or not) stop working the
// moment new ones are issued. Requires the current password as proof of
// intent, same as changing it.
app.post("/api/v1/me/recovery-codes", requireSessionOnly, (req, res) => {
  const { currentPassword } = req.body ?? {};
  const user = getUserById(req.user.id);

  if (!verifyPassword(currentPassword ?? "", user.passwordHash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  if (!user.totpEnabled) {
    return res.status(409).json({ error: "Two-factor authentication isn't enrolled on this account." });
  }

  const recoveryCodes = generateRecoveryCodes();
  deleteRecoveryCodesForUser(user.id);
  createRecoveryCodes(user.id, recoveryCodes.map(hashRecoveryCode), new Date().toISOString());

  return res.json({ recoveryCodes });
});

app.get("/api/v1/metrics", requireScope("metrics:read"), (req, res) => {
  return res.json(getBuildMetrics({ userId: req.user?.id ?? null }));
});

app.get("/api/v1/system", requireAdmin, async (req, res) => {
  const meta = getAppMeta();
  const versionCheck = await checkLatestVersion(appVersion);

  return res.json({
    version: appVersion,
    lastBootAt: meta?.updatedAt ?? null,
    activeBuild: queueState.activeBuild,
    queuedBuilds: queueState.buildQueue.length,
    // A bare count, not per-build detail — safe under absolute isolation
    // since it reveals nothing about any individual user's builds.
    totalBuildsAllUsers: getTotalBuildCount(),
    ...versionCheck,
  });
});

app.post("/api/v1/system/update", requireAdmin, (req, res) => {
  const targetRef = typeof req.body?.targetRef === "string" ? req.body.targetRef.trim() : undefined;

  try {
    const result = triggerUpdate({ targetRef: targetRef || undefined });
    logger.info("Update triggered via API", { targetRef: result.targetRef, userId: req.user.id });
    return res.status(202).json(result);
  } catch (error) {
    return res.status(409).json({ error: error.message });
  }
});

app.post("/api/v1/system/backup", requireAdmin, (req, res) => {
  try {
    const result = runBackup();
    logger.info("Backup triggered via API", { userId: req.user.id, archivePath: result.archivePath });
    return res.status(201).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/v1/system/logs", requireAdmin, (req, res) => {
  const lines = Math.min(Math.max(Number(req.query.lines) || 200, 1), 2000);
  const level = ["info", "warn", "error"].includes(req.query.level) ? req.query.level : undefined;

  return res.json({ entries: tailApiLog({ lines, level }) });
});

// --- Admin: user/invite/signup-request management ---
// Manages accounts, never user *data* — no build/log/artifact/key
// visibility is granted anywhere here, per absolute isolation.

app.get("/api/v1/admin/users", requireAdmin, (req, res) => {
  return res.json({
    users: listUsers().map((user) => ({ ...user, enabled: Boolean(user.enabled), totpEnabled: Boolean(user.totpEnabled) })),
  });
});

app.patch("/api/v1/admin/users/:id", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const target = getUserById(userId);

  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  const { enabled, role } = req.body ?? {};

  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean." });
    }

    if (userId === req.user.id && enabled === false) {
      return res.status(400).json({ error: "You cannot disable your own account." });
    }

    setUserEnabled(userId, enabled);
  }

  if (role !== undefined) {
    if (!["admin", "user"].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'user'." });
    }

    if (userId === req.user.id && role !== "admin") {
      return res.status(400).json({ error: "You cannot demote your own account." });
    }

    setUserRole(userId, role);
  }

  return res.json(sanitizeUserForResponse(getUserById(userId)));
});

// Generates a password_reset invite and hands back the link for the
// admin to copy/send out-of-band — this repo sends no email itself.
app.post("/api/v1/admin/users/:id/reset-password", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (!getUserById(userId)) {
    return res.status(404).json({ error: "User not found." });
  }

  const token = randomBytes(32).toString("hex");
  const now = new Date();

  createInvite({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    purpose: "password_reset",
    targetUserId: userId,
    createdBy: req.user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
  });

  return res.status(201).json({ link: buildInviteLink(token, "password_reset") });
});

// For a lost authenticator — clears enrollment so the account falls back
// into the same forced-enrollment flow a brand-new signup goes through,
// the next time its password is verified successfully.
app.post("/api/v1/admin/users/:id/reset-2fa", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (!getUserById(userId)) {
    return res.status(404).json({ error: "User not found." });
  }

  disableUserTotp(userId);

  return res.json({ id: userId, totpEnabled: false });
});

app.post("/api/v1/admin/invites", requireAdmin, (req, res) => {
  const { role, suggestedUsername, expiresInHours } = req.body ?? {};

  if (!["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin' or 'user'." });
  }

  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const hours = Number(expiresInHours) > 0 ? Number(expiresInHours) : 72;

  const result = createInvite({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    purpose: "signup",
    role,
    suggestedUsername: typeof suggestedUsername === "string" && suggestedUsername.trim() ? suggestedUsername.trim() : null,
    createdBy: req.user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3600 * 1000).toISOString(),
  });

  return res.status(201).json({ id: result.lastInsertRowid, link: buildInviteLink(token, "signup") });
});

app.get("/api/v1/admin/invites", requireAdmin, (req, res) => {
  return res.json({ invites: listInvites() });
});

app.delete("/api/v1/admin/invites/:id", requireAdmin, (req, res) => {
  deleteInvite(Number(req.params.id));
  return res.status(204).send();
});

app.get("/api/v1/admin/signup-requests", requireAdmin, (req, res) => {
  return res.json({ signupRequests: listSignupRequests() });
});

// Approving creates a signup invite pre-filled with the requester's
// chosen username and links back to this request for traceability — it
// does not create the account directly, the requester still completes
// the same invite flow anyone else would.
app.post("/api/v1/admin/signup-requests/:id/approve", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const signupRequest = getSignupRequestById(id);

  if (!signupRequest || signupRequest.status !== "pending") {
    return res.status(404).json({ error: "Signup request not found or already decided." });
  }

  const { role } = req.body ?? {};

  if (!["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin' or 'user'." });
  }

  const token = randomBytes(32).toString("hex");
  const now = new Date();

  createInvite({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    purpose: "signup",
    role,
    suggestedUsername: signupRequest.requestedUsername,
    signupRequestId: signupRequest.id,
    createdBy: req.user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 72 * 3600 * 1000).toISOString(),
  });

  decideSignupRequest(id, { status: "approved", decidedBy: req.user.id });

  return res.status(201).json({ link: buildInviteLink(token, "signup") });
});

app.post("/api/v1/admin/signup-requests/:id/reject", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const signupRequest = getSignupRequestById(id);

  if (!signupRequest || signupRequest.status !== "pending") {
    return res.status(404).json({ error: "Signup request not found or already decided." });
  }

  decideSignupRequest(id, { status: "rejected", decidedBy: req.user.id });

  return res.json({ id, status: "rejected" });
});

// --- Broadcast notifications ---
// The one sanctioned cross-user action in the whole isolation model: an
// admin sending everyone a heads-up (e.g. "restarting the server for an
// update"). Sending is admin-only; reading/dismissing is any signed-in
// account's own inbox.

app.post("/api/v1/admin/notifications", requireAdmin, (req, res) => {
  const { message } = req.body ?? {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required." });
  }

  const result = createNotification({
    message: message.trim().slice(0, 2000),
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
  });

  return res.status(201).json({ id: result.lastInsertRowid });
});

app.get("/api/v1/notifications", (req, res) => {
  if (!req.user) {
    return res.json({ notifications: [] });
  }

  return res.json({ notifications: listUnreadNotificationsForUser(req.user.id) });
});

app.post("/api/v1/notifications/:id/read", (req, res) => {
  if (!req.user) {
    return res.status(403).json({ error: "This action requires an identified account." });
  }

  markNotificationRead(Number(req.params.id), req.user.id);

  return res.status(204).send();
});

app.get("/download/:token/:filename", (req, res) => {
  const { token, filename } = req.params;

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(404).json({
      error: "Download not found.",
    });
  }

  if (
    filename !== filename.split("/").pop() ||
    filename !== filename.split("\\").pop() ||
    filename.includes("..")
  ) {
    return res.status(404).json({
      error: "Download not found.",
    });
  }

  const downloadToken = getArtifactDownloadToken(token);

  if (!downloadToken) {
    return res.status(404).json({
      error: "Download not found.",
    });
  }

  if (downloadToken.filename !== filename) {
    return res.status(404).json({
      error: "Download not found.",
    });
  }

  const artifactPath = resolve(
    process.cwd(),
    "builds",
    downloadToken.buildId,
    "artifacts",
    downloadToken.filename,
  );

  if (!existsSync(artifactPath)) {
    return res.status(404).json({
      error: "Download not found.",
    });
  }

  const stats = statSync(artifactPath);

  if (!stats.isFile()) {
    return res.status(404).json({
      error: "Download not found.",
    });
  }

  return res.download(
    artifactPath,
    downloadToken.filename,
  );
});

export { app };

// Only actually start the server (recover the queue, bind the port) when
// this file is run directly — lets tests import `app` and exercise it
// with supertest without spawning a real listener or touching the queue.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  upsertAppMeta(appVersion);
  reconstructQueueOnStartup();

  app.listen(port, () => {
    logger.info("Build API listening", { port, version: appVersion });
  });
}
