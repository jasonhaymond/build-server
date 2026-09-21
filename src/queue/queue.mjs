import { spawn } from "node:child_process";
import { updateBuild } from "../db/database.mjs";
import { serializeJobMasked } from "./jobPayload.mjs";

// Single shared, single-process queue state. Deliberately plain mutable
// state rather than a class/getter API — this process only ever runs one
// queue, and recovery.mjs needs to populate it directly at startup.
export const queueState = {
  buildQueue: [],
  builds: new Map(),
  activeBuild: false,
};

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

  console.log(`Starting build: ${id}`);

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
    console.error(`Worker failed to start for ${id}:`, error);

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

    build.exitCode = exitCode;
    build.completedAt = completedAt;

    if (exitCode === 0) {
      build.status = "completed";

      updateBuild(id, {
        status: "completed",
        completedAt,
        exitCode,
      });

      console.log(`Build completed: ${id}`);
    } else {
      build.status = "failed";

      updateBuild(id, {
        status: "failed",
        completedAt,
        exitCode,
      });

      console.error(
        `Build failed: ${id} (exit code ${exitCode})`,
      );
    }

    queueState.activeBuild = false;
    processQueue();
  });
}
