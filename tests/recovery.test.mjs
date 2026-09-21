import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBuild, getBuild, updateBuild } from "../src/db/database.mjs";
import { serializeJobForQueue } from "../src/queue/jobPayload.mjs";
import { queueState } from "../src/queue/queue.mjs";
import { reconstructQueueOnStartup } from "../src/queue/recovery.mjs";

function uniqueId(label) {
  return `bld_test_${label}_${Date.now().toString(36)}`;
}

describe("restart recovery", () => {
  it("reattaches to a still-running container and completes it", async () => {
    const id = uniqueId("reattach");
    const name = `build-android-${id}`;

    execFileSync("docker", [
      "run", "-d", "--name", name, "busybox", "sh", "-c", "sleep 3; exit 0",
    ]);

    createBuild({
      id,
      projectName: "ReattachTest",
      submittedAt: new Date().toISOString(),
      platform: "android",
    });
    updateBuild(id, { status: "building", startedAt: new Date().toISOString() });

    try {
      reconstructQueueOnStartup();

      await new Promise((resolve) => {
        const check = setInterval(() => {
          const row = getBuild(id);
          if (row.status !== "building") {
            clearInterval(check);
            resolve();
          }
        }, 200);
      });

      const finalRow = getBuild(id);
      expect(finalRow.status).toBe("completed");
      expect(finalRow.exitCode).toBe(0);
    } finally {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        // Already removed (--rm-less container exits into "Exited" state
        // but this cleans it up either way); nothing more to do.
      }
    }
  });

  it("marks a building row failed when no matching container is running", () => {
    const id = uniqueId("interrupted");

    createBuild({
      id,
      projectName: "InterruptedTest",
      submittedAt: new Date().toISOString(),
      platform: "android",
    });
    updateBuild(id, { status: "building", startedAt: new Date().toISOString() });

    reconstructQueueOnStartup();

    const row = getBuild(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("Interrupted by server restart");
  });

  it("round-trips an encrypted queued job through decryption without ever persisting the plaintext secret", async () => {
    const id = uniqueId("queued");
    const secretValue = "s3cr3t-value-should-never-be-stored-plaintext";

    const job = {
      id,
      project: {
        name: "QueuedRecoveryTest",
        source: { type: "directory", path: "/nonexistent" },
      },
      build: {
        platform: "android",
        variant: "debug",
        artifact: "apk",
        env: { PUBLIC_THING: "hello" },
        secrets: { FOO_SECRET: secretValue },
      },
    };

    createBuild({
      id,
      projectName: job.project.name,
      submittedAt: new Date().toISOString(),
      jobPayload: serializeJobForQueue(job, process.env.JOB_SECRETS_ENCRYPTION_KEY),
      platform: job.build.platform,
      variant: job.build.variant,
      artifactType: job.build.artifact,
    });

    const rawDb = new Database(process.env.DB_PATH, { readonly: true });
    const rawRow = rawDb.prepare("SELECT job_payload FROM builds WHERE id = ?").get(id);
    rawDb.close();

    expect(rawRow.job_payload.includes(secretValue)).toBe(false);

    reconstructQueueOnStartup();

    const reconstructed = queueState.builds.get(id);
    expect(reconstructed?.job?.build?.secrets?.FOO_SECRET).toBe(secretValue);

    await new Promise((resolve) => {
      const check = setInterval(() => {
        const row = getBuild(id);
        if (row.status !== "queued" && row.status !== "building") {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    // The directory source doesn't exist, so the real worker fails fast —
    // this still proves the full reconstructed-queue -> processQueue ->
    // real worker pipeline runs end to end.
    expect(getBuild(id).status).toBe("failed");
  });
});
