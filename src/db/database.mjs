import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.mjs";
import { migrations } from "./migrations/index.mjs";

const serverDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// DB_PATH lets tests point at an isolated, disposable database file
// instead of this deployment's real data/build-server.db.
const dbPath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(serverDir, "data", "build-server.db");

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

runMigrations(db, migrations);

export function createBuild({
  id,
  projectName,
  submittedAt,
  jobPayload,
  platform,
  variant,
  artifactType,
  apiKeyId,
  userId,
  submittedBy,
}) {
  db.prepare(`
    INSERT INTO builds (
      id,
      project_name,
      status,
      submitted_at,
      job_payload,
      platform,
      variant,
      artifact_type,
      api_key_id,
      user_id,
      submitted_by
    )
    VALUES (
      @id,
      @projectName,
      @status,
      @submittedAt,
      @jobPayload,
      @platform,
      @variant,
      @artifactType,
      @apiKeyId,
      @userId,
      @submittedBy
    )
  `).run({
    id,
    projectName,
    status: "queued",
    submittedAt,
    jobPayload: jobPayload ?? null,
    platform: platform ?? null,
    variant: variant ?? null,
    artifactType: artifactType ?? null,
    apiKeyId: apiKeyId ?? null,
    userId: userId ?? null,
    submittedBy: submittedBy ?? null,
  });
}

export function updateBuild(id, fields) {
  const allowedFields = [
    "status",
    "startedAt",
    "completedAt",
    "exitCode",
    "error",
    "jobPayload",
    "durationMs",
    "worker",
    "failureReason",
    "cancellationState",
  ];

  const updates = [];
  const values = { id };

  for (const field of allowedFields) {
    if (fields[field] !== undefined) {
      const column = field.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      );

      updates.push(`${column} = @${field}`);
      values[field] = fields[field];
    }
  }

  if (updates.length === 0) {
    return;
  }

  db.prepare(`
    UPDATE builds
    SET ${updates.join(", ")}
    WHERE id = @id
  `).run(values);
}

export function getBuild(id) {
  return db.prepare(`
    SELECT
      id,
      project_name AS projectName,
      status,
      submitted_at AS submittedAt,
      started_at AS startedAt,
      completed_at AS completedAt,
      exit_code AS exitCode,
      error,
      platform,
      variant,
      artifact_type AS artifactType,
      failure_reason AS failureReason,
      cancellation_state AS cancellationState,
      api_key_id AS apiKeyId,
      user_id AS userId
    FROM builds
    WHERE id = ?
  `).get(id);
}

// Used at API startup to reconstruct the in-memory queue — includes the
// persisted (possibly secret-encrypted) job payload needed to actually
// resume a build that never got past "queued" before a restart.
export function getQueuedBuildsForRecovery() {
  return db.prepare(`
    SELECT
      id,
      project_name AS projectName,
      submitted_at AS submittedAt,
      job_payload AS jobPayload
    FROM builds
    WHERE status = 'queued'
    ORDER BY submitted_at ASC
  `).all();
}

// Used at API startup to find builds that were mid-build when the API
// process last stopped, so recovery can check whether their container is
// still actually running before deciding to reattach or mark them failed.
export function getBuildingBuilds() {
  return db.prepare(`
    SELECT
      id,
      project_name AS projectName,
      submitted_at AS submittedAt,
      started_at AS startedAt,
      platform
    FROM builds
    WHERE status = 'building'
    ORDER BY submitted_at ASC
  `).all();
}

// userId scopes metrics to one workspace (every session-authenticated
// caller, and any key with a real owner); omitted only for a legacy
// unowned key, which keeps seeing today's global counts.
export function getBuildMetrics({ userId } = {}) {
  const where = userId != null ? "WHERE user_id = ?" : "";
  const params = userId != null ? [userId] : [];

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM builds
    ${where}
    GROUP BY status
  `).all(...params);

  const durationWhere = userId != null ? "WHERE duration_ms IS NOT NULL AND user_id = ?" : "WHERE duration_ms IS NOT NULL";
  const duration = db.prepare(`
    SELECT AVG(duration_ms) AS avgDurationMs, COUNT(*) AS sampleCount
    FROM builds
    ${durationWhere}
  `).get(...params);

  return {
    buildsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.count])),
    averageDurationMs: duration.avgDurationMs ?? null,
    durationSampleCount: duration.sampleCount,
  };
}

// A bare count, no per-build detail — safe for the admin system-overview
// panel even under absolute per-user isolation, since it reveals nothing
// about any individual user's builds.
export function getTotalBuildCount() {
  return db.prepare(`SELECT COUNT(*) AS count FROM builds`).get().count;
}

export function countUsers() {
  return db.prepare(`SELECT COUNT(*) AS count FROM users`).get().count;
}

export function createUser({ username, passwordHash, role, createdAt }) {
  return db.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      role,
      created_at
    )
    VALUES (
      @username,
      @passwordHash,
      @role,
      @createdAt
    )
  `).run({ username, passwordHash, role, createdAt });
}

export function getUserByUsername(username) {
  return db.prepare(`
    SELECT
      id,
      username,
      password_hash AS passwordHash,
      role,
      totp_secret AS totpSecret,
      totp_enabled AS totpEnabled,
      enabled,
      created_at AS createdAt,
      last_login_at AS lastLoginAt
    FROM users
    WHERE username = ?
  `).get(username);
}

export function getUserById(id) {
  return db.prepare(`
    SELECT
      id,
      username,
      password_hash AS passwordHash,
      role,
      totp_secret AS totpSecret,
      totp_enabled AS totpEnabled,
      enabled,
      created_at AS createdAt,
      last_login_at AS lastLoginAt
    FROM users
    WHERE id = ?
  `).get(id);
}

export function listUsers() {
  return db.prepare(`
    SELECT
      id,
      username,
      role,
      totp_enabled AS totpEnabled,
      enabled,
      created_at AS createdAt,
      last_login_at AS lastLoginAt
    FROM users
    ORDER BY created_at ASC
  `).all();
}

export function updateUserPassword(id, passwordHash) {
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
}

export function setUserTotpSecret(id, secret) {
  db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(secret, id);
}

export function enableUserTotp(id, secret) {
  db.prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?`).run(secret, id);
}

// Admin "reset 2FA" action — clears the enrolled secret so the account
// falls back into the same forced-enrollment flow a brand-new invite
// completion goes through, for someone who lost their authenticator.
export function disableUserTotp(id) {
  db.prepare(`UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?`).run(id);
}

export function setUserEnabled(id, enabled) {
  db.prepare(`UPDATE users SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function setUserRole(id, role) {
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
}

export function recordUserLogin(id) {
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function createRecoveryCodes(userId, codeHashes, createdAt) {
  const insert = db.prepare(`
    INSERT INTO user_recovery_codes (user_id, code_hash, created_at)
    VALUES (?, ?, ?)
  `);

  const insertAll = db.transaction((hashes) => {
    for (const hash of hashes) {
      insert.run(userId, hash, createdAt);
    }
  });

  insertAll(codeHashes);
}

// Regenerating replaces the whole set — old codes (used or not) stop
// working the moment new ones are issued.
export function deleteRecoveryCodesForUser(userId) {
  db.prepare(`DELETE FROM user_recovery_codes WHERE user_id = ?`).run(userId);
}

// Marks the first matching unused code as used and reports whether one
// was actually found — the caller treats "not found" as a wrong code.
export function consumeRecoveryCode(userId, codeHash) {
  const row = db.prepare(`
    SELECT id FROM user_recovery_codes
    WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
  `).get(userId, codeHash);

  if (!row) {
    return false;
  }

  db.prepare(`UPDATE user_recovery_codes SET used_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
  return true;
}

export function createSession({ tokenHash, userId, csrfToken, createdAt, expiresAt }) {
  return db.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at)
    VALUES (@tokenHash, @userId, @csrfToken, @createdAt, @expiresAt)
  `).run({ tokenHash, userId, csrfToken, createdAt, expiresAt });
}

// Joins straight through to the owning user — every caller needs both
// the session's own fields (csrf/expiry) and the user's identity/role in
// the same request, so this avoids a second round-trip every time.
export function getSessionWithUser(tokenHash) {
  return db.prepare(`
    SELECT
      s.id AS sessionId,
      s.csrf_token AS csrfToken,
      s.expires_at AS expiresAt,
      u.id AS userId,
      u.username,
      u.role,
      u.enabled AS userEnabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
}

export function deleteSessionByTokenHash(tokenHash) {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
}

// Housekeeping — called opportunistically from scripts/cleanup.mjs, not
// on a schedule of its own; an expired session is already rejected on
// lookup regardless, this just reclaims the row.
export function deleteExpiredSessions(nowIso) {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(nowIso);
}

export function createInvite({
  tokenHash,
  purpose,
  role,
  suggestedUsername,
  targetUserId,
  signupRequestId,
  createdBy,
  createdAt,
  expiresAt,
}) {
  return db.prepare(`
    INSERT INTO invites (
      token_hash, purpose, role, suggested_username, target_user_id,
      signup_request_id, created_by, created_at, expires_at
    )
    VALUES (
      @tokenHash, @purpose, @role, @suggestedUsername, @targetUserId,
      @signupRequestId, @createdBy, @createdAt, @expiresAt
    )
  `).run({
    tokenHash,
    purpose,
    role: role ?? null,
    suggestedUsername: suggestedUsername ?? null,
    targetUserId: targetUserId ?? null,
    signupRequestId: signupRequestId ?? null,
    createdBy,
    createdAt,
    expiresAt,
  });
}

function mapInviteRow(row) {
  if (!row) {
    return row;
  }

  return {
    id: row.id,
    purpose: row.purpose,
    role: row.role,
    suggestedUsername: row.suggested_username,
    targetUserId: row.target_user_id,
    signupRequestId: row.signup_request_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

// Only for actually redeeming a token — unused and unexpired. Listing
// for the admin panel (including used/expired ones) is listInvites().
export function getActiveInviteByTokenHash(tokenHash, nowIso) {
  return mapInviteRow(
    db.prepare(`
      SELECT * FROM invites
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash, nowIso),
  );
}

export function markInviteUsed(id) {
  db.prepare(`UPDATE invites SET used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function listInvites() {
  return db.prepare(`SELECT * FROM invites ORDER BY created_at DESC`).all().map(mapInviteRow);
}

export function deleteInvite(id) {
  db.prepare(`DELETE FROM invites WHERE id = ?`).run(id);
}

export function createSignupRequest({ requestedUsername, email, message, ipAddress, createdAt }) {
  return db.prepare(`
    INSERT INTO signup_requests (requested_username, email, message, ip_address, created_at)
    VALUES (@requestedUsername, @email, @message, @ipAddress, @createdAt)
  `).run({
    requestedUsername,
    email: email ?? null,
    message: message ?? null,
    ipAddress: ipAddress ?? null,
    createdAt,
  });
}

function mapSignupRequestRow(row) {
  if (!row) {
    return row;
  }

  return {
    id: row.id,
    requestedUsername: row.requested_username,
    email: row.email,
    message: row.message,
    status: row.status,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function listSignupRequests() {
  return db.prepare(`SELECT * FROM signup_requests ORDER BY created_at DESC`).all().map(mapSignupRequestRow);
}

export function getSignupRequestById(id) {
  return mapSignupRequestRow(db.prepare(`SELECT * FROM signup_requests WHERE id = ?`).get(id));
}

export function decideSignupRequest(id, { status, decidedBy }) {
  db.prepare(`
    UPDATE signup_requests
    SET status = ?, decided_at = ?, decided_by = ?
    WHERE id = ?
  `).run(status, new Date().toISOString(), decidedBy, id);
}

export function createNotification({ message, createdBy, createdAt }) {
  return db.prepare(`
    INSERT INTO notifications (message, created_by, created_at)
    VALUES (?, ?, ?)
  `).run(message, createdBy, createdAt);
}

export function listNotifications() {
  return db.prepare(`
    SELECT id, message, created_by AS createdBy, created_at AS createdAt
    FROM notifications
    ORDER BY created_at DESC
  `).all();
}

// Unread = no matching notification_reads row for this user yet.
export function listUnreadNotificationsForUser(userId) {
  return db.prepare(`
    SELECT n.id, n.message, n.created_at AS createdAt
    FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
    WHERE r.notification_id IS NULL
    ORDER BY n.created_at ASC
  `).all(userId);
}

export function markNotificationRead(notificationId, userId) {
  db.prepare(`
    INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
    VALUES (?, ?, ?)
  `).run(notificationId, userId, new Date().toISOString());
}

export function createApiKey({
  name,
  keyHash,
  createdAt,
  scopes,
  userId,
}) {
  return db.prepare(`
    INSERT INTO api_keys (
      name,
      key_hash,
      created_at,
      scopes,
      user_id
    )
    VALUES (
      @name,
      @keyHash,
      @createdAt,
      @scopes,
      @userId
    )
  `).run({
    name,
    keyHash,
    createdAt,
    scopes: scopes ?? null,
    userId: userId ?? null,
  });
}

export function getApiKeyByHash(keyHash) {
  return db.prepare(`
    SELECT
      id,
      name,
      key_hash AS keyHash,
      created_at AS createdAt,
      enabled,
      scopes,
      user_id AS userId
    FROM api_keys
    WHERE key_hash = ?
      AND enabled = 1
  `).get(keyHash);
}

// Every key created going forward belongs to exactly one user's profile
// (see docs on "Key architectural decisions") — this always lists one
// workspace's own keys, never every key on the server.
export function listApiKeysForUser(userId) {
  return db.prepare(`
    SELECT
      id,
      name,
      created_at AS createdAt,
      enabled,
      scopes
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId);
}

export function getApiKeyById(id) {
  return db.prepare(`
    SELECT id, name, created_at AS createdAt, enabled, scopes, user_id AS userId
    FROM api_keys
    WHERE id = ?
  `).get(id);
}

export function disableApiKey(id) {
  db.prepare(`UPDATE api_keys SET enabled = 0 WHERE id = ?`).run(id);
}

// Permanent — unlike disableApiKey (revoke), the row is actually gone
// afterward. Only meant to be called on an already-disabled key (see
// server.mjs's requireDisabled-before-purge check) so there's no path
// to destroying a still-active credential without revoking it first.
export function deleteApiKey(id) {
  db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
}


export function createArtifactDownloadToken({
  tokenHash,
  buildId,
  filename,
  createdAt,
}) {
  return db.prepare(`
    INSERT INTO artifact_download_tokens (
      token_hash,
      build_id,
      filename,
      created_at
    )
    VALUES (
      @tokenHash,
      @buildId,
      @filename,
      @createdAt
    )
  `).run({
    tokenHash,
    buildId,
    filename,
    createdAt,
  });
}

export function getArtifactDownloadTokenForArtifact({
  buildId,
  filename,
}) {
  return db.prepare(`
    SELECT
      id,
      token_hash AS tokenHash,
      build_id AS buildId,
      filename,
      created_at AS createdAt,
      enabled
    FROM artifact_download_tokens
    WHERE build_id = ?
      AND filename = ?
      AND enabled = 1
    LIMIT 1
  `).get(buildId, filename);
}

export function getArtifactDownloadToken(tokenHash) {
  return db.prepare(`
    SELECT
      id,
      token_hash AS tokenHash,
      build_id AS buildId,
      filename,
      created_at AS createdAt,
      enabled
    FROM artifact_download_tokens
    WHERE token_hash = ?
      AND enabled = 1
  `).get(tokenHash);
}

export function disableArtifactDownloadTokenForArtifact({ buildId, filename }) {
  db.prepare(`
    UPDATE artifact_download_tokens
    SET enabled = 0
    WHERE build_id = ?
      AND filename = ?
  `).run(buildId, filename);
}

// Written by the worker once it copies an artifact out of the build
// container — replaces the old scan-the-directory-and-lazily-create-a-
// token approach with a proper metadata table populated at build time.
export function createArtifactRecord({
  buildId,
  filename,
  type,
  size,
  createdAt,
  downloadTokenId,
}) {
  return db.prepare(`
    INSERT INTO artifacts (
      build_id,
      filename,
      type,
      size,
      created_at,
      download_token_id
    )
    VALUES (
      @buildId,
      @filename,
      @type,
      @size,
      @createdAt,
      @downloadTokenId
    )
  `).run({
    buildId,
    filename,
    type: type ?? null,
    size,
    createdAt,
    downloadTokenId,
  });
}

export function getArtifactsForBuild(buildId) {
  return db.prepare(`
    SELECT
      a.filename AS filename,
      a.size AS size,
      a.type AS type,
      t.token_hash AS downloadToken
    FROM artifacts a
    JOIN artifact_download_tokens t ON t.id = a.download_token_id
    WHERE a.build_id = ?
      AND a.enabled = 1
      AND t.enabled = 1
    ORDER BY a.created_at ASC
  `).all(buildId);
}

// Retention/cleanup: builds whose terminal state is old enough to sweep.
export function getCleanableBuilds(cutoffIso) {
  return db.prepare(`
    SELECT id
    FROM builds
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND completed_at IS NOT NULL
      AND completed_at < ?
  `).all(cutoffIso);
}

export function disableArtifactsForBuild(buildId) {
  db.prepare(`UPDATE artifacts SET enabled = 0 WHERE build_id = ?`).run(buildId);
  db.prepare(`UPDATE artifact_download_tokens SET enabled = 0 WHERE build_id = ?`).run(buildId);
}

// Upserted on every successful boot (not just deploys), so it reflects
// what's actually been running rather than what a deploy script assumed —
// this is what makes a backup's filename traceable to a real running
// version, and what a restore checks to confirm which version came back.
export function upsertAppMeta(version) {
  db.prepare(`
    INSERT INTO app_meta (id, version, updated_at)
    VALUES (1, @version, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run({ version, updatedAt: new Date().toISOString() });
}

export function getAppMeta() {
  return db.prepare(`
    SELECT version, updated_at AS updatedAt
    FROM app_meta
    WHERE id = 1
  `).get();
}

// Powers the web UI's dashboard, scoped to exactly one workspace — no
// admin bypass (absolute isolation; see src/api/server.mjs). A real
// userId sees only builds it owns, full stop. A legacy unowned key
// (userId null) keeps today's pre-migration behavior: its own
// api_key_id, plus any build with no owner recorded at all — but never
// another real user's builds, which always carry a user_id now.
export function listBuilds({ userId, apiKeyId, limit, offset }) {
  const baseColumns = `
    id,
    project_name AS projectName,
    status,
    submitted_at AS submittedAt,
    started_at AS startedAt,
    completed_at AS completedAt,
    platform,
    variant,
    artifact_type AS artifactType,
    failure_reason AS failureReason
  `;

  if (userId != null) {
    return db.prepare(`
      SELECT ${baseColumns}
      FROM builds
      WHERE user_id = ?
      ORDER BY submitted_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset);
  }

  return db.prepare(`
    SELECT ${baseColumns}
    FROM builds
    WHERE user_id IS NULL AND (api_key_id = ? OR api_key_id IS NULL)
    ORDER BY submitted_at DESC
    LIMIT ? OFFSET ?
  `).all(apiKeyId, limit, offset);
}
