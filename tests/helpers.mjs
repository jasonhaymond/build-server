import { createHash, createHmac, randomBytes } from "node:crypto";
import { createApiKey, createInvite, createSession, createUser, enableUserTotp } from "../src/db/database.mjs";
import { SESSION_COOKIE_NAME } from "../src/security/cookies.mjs";
import { hashPassword } from "../src/security/passwords.mjs";
import { generateTotpSecret } from "../src/security/totp.mjs";

export function createTestApiKey({ name = "test-key", scopes, userId } = {}) {
  const key = `abs_test_${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");

  createApiKey({
    name,
    keyHash,
    createdAt: new Date().toISOString(),
    scopes: scopes ? scopes.join(",") : null,
    userId,
  });

  return key;
}

let testUserCounter = 0;

export function createTestUser({ role = "user" } = {}) {
  testUserCounter += 1;

  const result = createUser({
    username: `test-user-${testUserCounter}-${randomBytes(4).toString("hex")}`,
    passwordHash: hashPassword("irrelevant-test-password-1"),
    role,
    createdAt: new Date().toISOString(),
  });

  return { id: result.lastInsertRowid };
}

// Creates a real session row directly (bypassing the HTTP login/MFA
// dance, which tests/auth.test.mjs exercises on its own) — everything
// else in the suite just needs "a signed-in session" as a fixture.
export function createTestSession({ role = "user" } = {}) {
  const user = createTestUser({ role });
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 3600 * 1000);

  createSession({
    tokenHash,
    userId: user.id,
    csrfToken,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return {
    userId: user.id,
    cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
    csrfToken,
  };
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of input.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

// Independent re-implementation of RFC 6238 (not imported from
// src/security/totp.mjs) so tests exercise the real server-side
// verifyTotpCode against a code computed a different way, rather than
// trivially agreeing with itself.
export function currentTotpCode(secretBase32) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 1e6).padStart(6, "0");
}

export function createTestUserWithTotp({ role = "user" } = {}) {
  const user = createTestUser({ role });
  const secret = generateTotpSecret();
  enableUserTotp(user.id, secret);
  return { id: user.id, secret };
}

export function createTestInvite({
  purpose = "signup",
  role = "user",
  suggestedUsername,
  targetUserId,
  createdBy,
  expiresInMs = 60 * 60 * 1000,
} = {}) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();

  createInvite({
    tokenHash,
    purpose,
    role: purpose === "signup" ? role : null,
    suggestedUsername: suggestedUsername ?? null,
    targetUserId: targetUserId ?? null,
    signupRequestId: null,
    createdBy: createdBy ?? createTestUser({ role: "admin" }).id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  });

  return token;
}

// Source path doesn't need to exist for most tests — the worker fails
// fast validating it, which is fine when the test only cares about the
// API's own request handling, not the build actually succeeding.
export function sampleJob(overrides = {}) {
  return {
    project: {
      name: "TestProject",
      source: { type: "directory", path: "/nonexistent" },
    },
    build: {
      platform: "android",
      variant: "debug",
      artifact: "apk",
    },
    ...overrides,
  };
}
