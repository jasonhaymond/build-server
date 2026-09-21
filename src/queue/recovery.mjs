import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBuildingBuilds,
  getQueuedBuildsForRecovery,
  updateBuild,
} from "../db/database.mjs";
import { createLogger } from "../logging/logger.mjs";
import { deserializeJobFromQueue } from "./jobPayload.mjs";
import { processQueue, queueState } from "./queue.mjs";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildsDir = resolve(serverDir, "builds");
const logger = createLogger("recovery");

function containerNameFor(platform, id) {
  return `build-${platform}-${id}`;
}

function isContainerRunning(name) {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"],
      { encoding: "utf8" },
    ).trim();

    return output === name;
  } catch {
    // Docker unreachable, or the container is simply gone — either way,
    // it's not something we can safely reattach to.
    return false;
  }
}

function markInterrupted(id, reason) {
  updateBuild(id, {
    status: "failed",
    completedAt: new Date().toISOString(),
    exitCode: 1,
    error: reason,
    failureReason: reason,
  });
}

// A build that was `building` when the API stopped might still have a live
// container on the Docker daemon (the daemon isn't restarted with the API
// process). Reattach to it rather than blindly requeuing — requeuing would
// run a second, duplicate build alongside one that's already in progress.
function reattachBuildingBuild(row) {
  const name = containerNameFor(row.platform, row.id);

  logger.info("Reattaching to running build", { id: row.id, container: name });

  queueState.activeBuild = true;

  const logPath = resolve(buildsDir, row.id, "logs", "build.log");
  mkdirSync(dirname(logPath), { recursive: true });

  const logs = spawn("docker", ["logs", "-f", name], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  logs.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
  logs.stderr.on("data", (chunk) => appendFileSync(logPath, chunk));

  const wait = spawn("docker", ["wait", name], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  let waitOutput = "";
  wait.stdout.on("data", (chunk) => {
    waitOutput += chunk.toString();
  });

  wait.on("close", () => {
    const exitCode = Number.parseInt(waitOutput.trim(), 10) || 0;
    const completedAt = new Date().toISOString();
    const durationMs = row.startedAt ? Date.now() - Date.parse(row.startedAt) : null;

    if (exitCode === 0) {
      updateBuild(row.id, { status: "completed", completedAt, exitCode, durationMs });
      logger.info("Reattached build completed", { id: row.id, durationMs });
    } else {
      updateBuild(row.id, { status: "failed", completedAt, exitCode, durationMs });
      logger.error("Reattached build failed", { id: row.id, exitCode, durationMs });
    }

    queueState.activeBuild = false;
    processQueue();
  });

  wait.on("error", (error) => {
    logger.error("Lost track of reattached build", { id: row.id, error: error.message });
    markInterrupted(row.id, `Lost track of build after restart: ${error.message}`);
    queueState.activeBuild = false;
    processQueue();
  });
}

export function reconstructQueueOnStartup() {
  const buildingRows = getBuildingBuilds();

  for (const row of buildingRows) {
    if (row.platform && isContainerRunning(containerNameFor(row.platform, row.id))) {
      reattachBuildingBuild(row);
    } else {
      logger.error("Build interrupted by restart (no running container found)", { id: row.id });
      markInterrupted(row.id, "Interrupted by server restart");
    }
  }

  const queuedRows = getQueuedBuildsForRecovery();
  let requeued = 0;

  for (const row of queuedRows) {
    if (!row.jobPayload) {
      markInterrupted(row.id, "Lost on server restart (no persisted job payload)");
      continue;
    }

    let job;

    try {
      job = deserializeJobFromQueue(row.jobPayload, process.env.JOB_SECRETS_ENCRYPTION_KEY);
    } catch (error) {
      markInterrupted(row.id, `Could not decrypt persisted job payload: ${error.message}`);
      continue;
    }

    queueState.builds.set(row.id, {
      id: row.id,
      status: "queued",
      submittedAt: row.submittedAt,
      job,
    });

    queueState.buildQueue.push(row.id);
    requeued += 1;
  }

  if (requeued > 0) {
    logger.info("Reconstructed queued builds from the database", { count: requeued });
  }

  processQueue();
}
