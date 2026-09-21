import { spawn } from "node:child_process";
import { updateBuild } from "../db/database.mjs";
import { createLogger } from "../logging/logger.mjs";
import { serializeJobMasked } from "./jobPayload.mjs";

const logger = createLogger("queue");

// Single shared, single-process queue state. Deliberately plain mutable
// state rather than a class/getter API — this process only ever runs one
// queue, and recovery.mjs needs to populate it directly at startup.
export const queueState = {
  buildQueue: [],
  builds: new Map(),
  activeBuild: false,
  // Build ids currently being cancelled (docker kill sent, awaiting the
  // worker's close event) — lets the close handler report "cancelled"
  // instead of the generic "failed" a killed container would otherwise get.
  cancelling: new Set(),
};

// Removes a not-yet-started build from the queue. Returns false if the
// build isn't queued (it's already building, or doesn't exist) — the
// caller is responsible for cancelling an in-progress build instead.
export function cancelQueuedBuild(id) {
  const index = queueState.buildQueue.indexOf(id);

  if (index === -1) {
    return false;
  }

  queueState.buildQueue.splice(index, 1);
  queueState.builds.delete(id);

  updateBuild(id, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
    cancellationState: "cancelled",
  });

  return true;
}

export function processQueue() {
  if (queueState.activeBuild || queueState.buildQueue.length === 0) {
    return;
  }

  const id = queueState.buildQueue.shift();
  const build = queueState.builds.get(id);

  if (!build) {
    processQueue();
    return;
  }

  queueState.activeBuild = true;

  const startedAt = new Date().toISOString();

  build.status = "building";
  build.startedAt = startedAt;

  updateBuild(id, {
    status: "building",
    startedAt,
    // The encrypted-secrets payload has served its purpose once a build
    // actually starts — replace it with the same `***` masking used for
    // job.json so secrets aren't sitting in the database any longer than
    // they need to be.
    jobPayload: serializeJobMasked(build.job),
  });

  logger.info("Starting build", { id });

  const worker = spawn(
    "node",
    ["src/worker/index.mjs"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  worker.stdin.write(JSON.stringify(build.job));
  worker.stdin.end();

  worker.on("error", (error) => {
    logger.error("Worker failed to start", { id, error: error.message });

    const completedAt = new Date().toISOString();

    build.status = "failed";
    build.error = error.message;
    build.completedAt = completedAt;
    build.exitCode = 1;

    updateBuild(id, {
      status: "failed",
      error: error.message,
      completedAt,
      exitCode: 1,
      failureReason: error.message,
    });

    queueState.activeBuild = false;
    processQueue();
  });

  worker.on("close", (code) => {
    const completedAt = new Date().toISOString();
    const exitCode = code ?? 1;
    const durationMs = Date.now() - Date.parse(startedAt);

    build.exitCode = exitCode;
    build.completedAt = completedAt;

    if (queueState.cancelling.delete(id)) {
      build.status = "cancelled";

      updateBuild(id, {
        status: "cancelled",
        completedAt,
        exitCode,
        durationMs,
        cancellationState: "cancelled",
      });

      logger.info("Build cancelled", { id });
    } else if (exitCode === 0) {
      build.status = "completed";

      updateBuild(id, {
        status: "completed",
        completedAt,
        exitCode,
        durationMs,
      });

      logger.info("Build completed", { id, durationMs });
    } else {
      build.status = "failed";

      updateBuild(id, {
        status: "failed",
        completedAt,
        exitCode,
        durationMs,
      });

      logger.error("Build failed", { id, exitCode, durationMs });
    }

    queueState.activeBuild = false;
    processQueue();
  });
}
