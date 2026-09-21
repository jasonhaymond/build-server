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

const dataDir = resolve(serverDir, "data");

mkdirSync(dataDir, { recursive: true });

const dbPath = resolve(dataDir, "build-server.db");

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
      api_key_id AS apiKeyId
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
      platform
    FROM builds
    WHERE status = 'building'
    ORDER BY submitted_at ASC
  `).all();
}

export function createApiKey({
  name,
  keyHash,
  createdAt,
  scopes,
}) {
  return db.prepare(`
    INSERT INTO api_keys (
      name,
      key_hash,
      created_at,
      scopes
    )
    VALUES (
      @name,
      @keyHash,
      @createdAt,
      @scopes
    )
  `).run({
    name,
    keyHash,
    createdAt,
    scopes: scopes ?? null,
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
      scopes
    FROM api_keys
    WHERE key_hash = ?
      AND enabled = 1
  `).get(keyHash);
}

export function listApiKeys() {
  return db.prepare(`
    SELECT
      id,
      name,
      created_at AS createdAt,
      enabled,
      scopes
    FROM api_keys
    ORDER BY created_at ASC
  `).all();
}

export function getApiKeyById(id) {
  return db.prepare(`
    SELECT id, name, created_at AS createdAt, enabled, scopes
    FROM api_keys
    WHERE id = ?
  `).get(id);
}

export function disableApiKey(id) {
  db.prepare(`UPDATE api_keys SET enabled = 0 WHERE id = ?`).run(id);
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
