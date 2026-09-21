#!/usr/bin/env node

import express from "express";
import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  createArtifactDownloadToken,
  createBuild,
  getApiKeyByHash,
  getArtifactDownloadToken,
  getArtifactDownloadTokenForArtifact,
  getBuild,
} from "../db/database.mjs";
import { serializeJobForQueue } from "../queue/jobPayload.mjs";
import { processQueue, queueState } from "../queue/queue.mjs";
import { reconstructQueueOnStartup } from "../queue/recovery.mjs";
import { encryptSecrets } from "../security/secrets.mjs";

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
  };

  next();
}


function createBuildId() {
  return `bld_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function createArtifactToken() {
  return createHash("sha256")
    .update(randomBytes(32))
    .digest("hex");
}

function sanitizeBuildForResponse(build) {
  return {
    id: build.id,
    status: build.status,
    submittedAt: build.submittedAt,
    startedAt: build.startedAt ?? null,
    completedAt: build.completedAt ?? null,
    exitCode: build.exitCode ?? null,
    error: build.error ?? null,
  };
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "build-server",
    activeBuild: queueState.activeBuild,
    queuedBuilds: queueState.buildQueue.length,
  });
});

app.use("/api/v1", authenticateApiKey);

app.post("/api/v1/builds", (req, res) => {
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

  console.log(`Build queued: ${id}`);

  processQueue();

  return res.status(202).json({
    id,
    status: build.status,
  });
});

app.get("/api/v1/builds/:id", (req, res) => {
  const build = getBuild(req.params.id);

  if (!build) {
    return res.status(404).json({
      error: "Build not found.",
    });
  }

  return res.json(sanitizeBuildForResponse(build));
});

app.get("/api/v1/builds/:id/logs", (req, res) => {
  const build = getBuild(req.params.id);

  if (!build) {
    return res.status(404).json({
      error: "Build not found.",
    });
  }

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

app.get("/api/v1/builds/:id/artifacts", (req, res) => {
  const build = getBuild(req.params.id);

  if (!build) {
    return res.status(404).json({
      error: "Build not found.",
    });
  }

  const artifactsDir = resolve(
    process.cwd(),
    "builds",
    req.params.id,
    "artifacts",
  );

  if (!existsSync(artifactsDir)) {
    return res.json({
      id: req.params.id,
      artifacts: [],
    });
  }

  const artifacts = readdirSync(artifactsDir)
    .map((name) => {
      const path = resolve(artifactsDir, name);
      const stats = statSync(path);

      if (!stats.isFile()) {
        return null;
      }

      let downloadToken = getArtifactDownloadTokenForArtifact({
        buildId: req.params.id,
        filename: name,
      });

      if (!downloadToken) {
        const token = createArtifactToken();

        createArtifactDownloadToken({
          tokenHash: token,
          buildId: req.params.id,
          filename: name,
          createdAt: new Date().toISOString(),
        });

        downloadToken = {
          tokenHash: token,
        };
      }

      return {
        filename: name,
        size: stats.size,
        downloadUrl: `${publicBaseUrl}/download/${downloadToken.tokenHash}/${encodeURIComponent(name)}`,
      };
    })
    .filter(Boolean);

  return res.json({
    id: req.params.id,
    artifacts,
  });
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

app.get("/api/v1/builds/:id/artifacts/:filename", (req, res) => {
  const build = getBuild(req.params.id);

  if (!build) {
    return res.status(404).json({
      error: "Build not found.",
    });
  }

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

reconstructQueueOnStartup();

app.listen(port, () => {
  console.log(`Build API listening on port ${port}`);
});

