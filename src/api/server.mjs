#!/usr/bin/env node

import express from "express";
import {
  createHash,
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
  createApiKey,
  createBuild,
  disableApiKey,
  disableArtifactDownloadTokenForArtifact,
  getApiKeyByHash,
  getApiKeyById,
  getArtifactDownloadToken,
  getArtifactsForBuild,
  getBuild,
  getBuildMetrics,
  listApiKeys,
  listBuilds,
  upsertAppMeta,
} from "../db/database.mjs";
import { createLogger } from "../logging/logger.mjs";
import { serializeJobForQueue } from "../queue/jobPayload.mjs";
import { cancelQueuedBuild, processQueue, queueState } from "../queue/queue.mjs";
import { reconstructQueueOnStartup } from "../queue/recovery.mjs";
import { encryptSecrets } from "../security/secrets.mjs";
import { KNOWN_SCOPES, hasScope, parseScopes, serializeScopes } from "../security/scopes.mjs";

const logger = createLogger("api");
const app = express();
const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const secretsKey = process.env.JOB_SECRETS_ENCRYPTION_KEY;

// Fail fast at startup rather than on the first build submission.
try {
  encryptSecrets({}, secretsKey);
} catch (error) {
  console.error(error.message);
  process.exit(1);
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
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

function authenticateApiKey(req, res, next) {
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

  next();
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req.apiKey, scope)) {
      return res.status(403).json({
        error: `API key missing required scope: ${scope}`,
      });
    }

    next();
  };
}

// Combines the scope check with build ownership: a key can only act on
// builds submitted with itself, unless it holds the build:read:any
// escape hatch. A build with no recorded owner (submitted before
// multi-tenant tracking existed) is treated as accessible to any key with
// the right scope, since there's no owner on record to check against.
// Mismatches return 404, not 403, to avoid confirming a build ID exists.
function requireBuildAccess(scope) {
  return (req, res, next) => {
    if (!hasScope(req.apiKey, scope)) {
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

    if (
      build.apiKeyId != null &&
      build.apiKeyId !== req.apiKey.id &&
      !hasScope(req.apiKey, "build:read:any")
    ) {
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

app.use("/api/v1", authenticateApiKey);

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
    apiKeyId: req.apiKey.id,
    submittedBy: req.apiKey.name,
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
    apiKeyId: req.apiKey.id,
    includeAll: hasScope(req.apiKey, "build:read:any"),
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

app.post("/api/v1/api-keys", requireScope("api-key:manage"), (req, res) => {
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
  });

  return res.status(201).json({
    id: result.lastInsertRowid,
    name,
    scopes: scopes ?? null,
    key,
  });
});

app.get("/api/v1/api-keys", requireScope("api-key:manage"), (req, res) => {
  const keys = listApiKeys().map((key) => ({
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    enabled: Boolean(key.enabled),
    scopes: parseScopes(key.scopes),
  }));

  return res.json({ apiKeys: keys });
});

app.delete("/api/v1/api-keys/:id", requireScope("api-key:manage"), (req, res) => {
  const key = getApiKeyById(Number(req.params.id));

  if (!key) {
    return res.status(404).json({
      error: "API key not found.",
    });
  }

  disableApiKey(key.id);

  return res.json({ id: key.id, enabled: false });
});

app.get("/api/v1/metrics", requireScope("metrics:read"), (req, res) => {
  return res.json(getBuildMetrics());
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
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  upsertAppMeta(version);
  reconstructQueueOnStartup();

  app.listen(port, () => {
    logger.info("Build API listening", { port, version });
  });
}
