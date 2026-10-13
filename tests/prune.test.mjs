import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuild, getArtifactsForBuild, updateBuild } from "../src/db/database.mjs";
import { pruneBuildData } from "../src/system/prune.mjs";
import { registerArtifact } from "../src/worker/artifacts.mjs";
import { createTestUser } from "./helpers.mjs";

const buildsDir = mkdtempSync(join(tmpdir(), "build-server-prune-"));

function makeBuild({ id, userId, projectName = "PruneApp", platform = "android", status = "completed", minutesAgo }) {
  const jobDir = join(buildsDir, id);

  for (const sub of ["source", "work", "artifacts", "logs"]) {
    mkdirSync(join(jobDir, sub), { recursive: true });
  }

  writeFileSync(join(jobDir, "source", "package.json"), "{}");
  writeFileSync(join(jobDir, "work", "cache.bin"), "cache");
  writeFileSync(join(jobDir, "logs", "build.log"), "log output");
  writeFileSync(join(jobDir, "job.json"), "{}");

  const completedAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();

  createBuild({ id, projectName, submittedAt: completedAt, platform, userId });
  updateBuild(id, { status, completedAt, exitCode: status === "completed" ? 0 : 1 });

  if (status === "completed") {
    const path = join(jobDir, "artifacts", `${id}.apk`);
    writeFileSync(path, "fake apk");
    registerArtifact({ buildId: id, filename: `${id}.apk`, type: "apk", path });
  }

  return jobDir;
}

const has = (id, sub) => existsSync(join(buildsDir, id, sub));

let owner;
let otherOwner;

beforeAll(() => {
  owner = createTestUser().id;
  otherOwner = createTestUser().id;

  makeBuild({ id: "bld_prune_old", userId: owner, minutesAgo: 40 });
  makeBuild({ id: "bld_prune_failed", userId: owner, status: "failed", minutesAgo: 30 });
  makeBuild({ id: "bld_prune_mid", userId: owner, minutesAgo: 20 });
  makeBuild({ id: "bld_prune_new", userId: owner, minutesAgo: 10 });
  // Same project name, different owner — must not count against `owner`'s two.
  makeBuild({ id: "bld_prune_other", userId: otherOwner, minutesAgo: 50 });

  pruneBuildData({ buildsDir, keepPerProject: 2 });
});

afterAll(() => {
  rmSync(buildsDir, { recursive: true, force: true });
});

describe("automatic build data pruning", () => {
  it("removes source and work for every finished build", () => {
    for (const id of ["bld_prune_old", "bld_prune_failed", "bld_prune_mid", "bld_prune_new"]) {
      expect(has(id, "source")).toBe(false);
      expect(has(id, "work")).toBe(false);
    }
  });

  it("keeps the newest two completed builds' artifacts per project", () => {
    expect(has("bld_prune_new", "artifacts")).toBe(true);
    expect(has("bld_prune_mid", "artifacts")).toBe(true);
    expect(getArtifactsForBuild("bld_prune_new")).toHaveLength(1);
    expect(getArtifactsForBuild("bld_prune_mid")).toHaveLength(1);
  });

  it("deletes and disables older artifacts", () => {
    expect(has("bld_prune_old", "artifacts")).toBe(false);
    expect(getArtifactsForBuild("bld_prune_old")).toHaveLength(0);
  });

  it("keeps logs and job.json so history stays viewable", () => {
    expect(has("bld_prune_old", "logs/build.log")).toBe(true);
    expect(has("bld_prune_old", "job.json")).toBe(true);
    expect(has("bld_prune_failed", "logs/build.log")).toBe(true);
  });

  it("scopes retention to the owner, not just the project name", () => {
    expect(has("bld_prune_other", "artifacts")).toBe(true);
    expect(getArtifactsForBuild("bld_prune_other")).toHaveLength(1);
  });

  it("is idempotent", () => {
    expect(pruneBuildData({ buildsDir, keepPerProject: 2 })).toBe(0);
  });
});
