import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { disableArtifactsForBuild, getPrunableBuilds } from "../db/database.mjs";
import { createLogger } from "../logging/logger.mjs";

const logger = createLogger("prune");

const defaultBuildsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../builds");

export function keepArtifactsPerProject() {
  const value = Number(process.env.KEEP_ARTIFACTS_PER_PROJECT ?? 2);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}

// Staged source and work/ (node_modules, Gradle cache) are gigabytes per
// build and never read again once a build finishes, so they go for every
// terminal build. Artifacts survive only for the newest completed builds
// of each project. logs/ and job.json are left alone so the build's
// history and log stay viewable in the web UI. Idempotent — safe to run
// after every build.
export function pruneBuildData({ buildsDir = defaultBuildsDir, keepPerProject = keepArtifactsPerProject() } = {}) {
  let freedBuilds = 0;

  for (const { id, keepArtifacts } of getPrunableBuilds(keepPerProject)) {
    const jobDir = resolve(buildsDir, id);
    const targets = ["source", "work"];

    if (!keepArtifacts) {
      targets.push("artifacts");
    }

    const existing = targets.map((name) => resolve(jobDir, name)).filter((path) => existsSync(path));

    if (existing.length === 0) {
      continue;
    }

    for (const path of existing) {
      rmSync(path, { recursive: true, force: true });
    }

    if (!keepArtifacts) {
      disableArtifactsForBuild(id);
    }

    freedBuilds += 1;
  }

  if (freedBuilds > 0) {
    logger.info("Pruned build data", { builds: freedBuilds, keepPerProject });
  }

  return freedBuilds;
}

export function pruneBuildDataSafely(options) {
  try {
    return pruneBuildData(options);
  } catch (error) {
    logger.error("Build data pruning failed", { error: error.message });
    return 0;
  }
}
