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
}) {
  return db.prepare(`
    INSERT INTO api_keys (
      name,
      key_hash,
      created_at
    )
    VALUES (
      @name,
      @keyHash,
      @createdAt
    )
  `).run({
    name,
    keyHash,
    createdAt,
  });
}

export function getApiKeyByHash(keyHash) {
  return db.prepare(`
    SELECT
      id,
      name,
      key_hash AS keyHash,
      created_at AS createdAt,
      enabled
    FROM api_keys
    WHERE key_hash = ?
      AND enabled = 1
  `).get(keyHash);
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
