#!/usr/bin/env node

// Deletes on-disk build directories (artifacts, logs) for builds whose
// terminal state is older than RETENTION_DAYS, and disables their
// download tokens. The builds table row itself is kept for history —
// only the files and the ability to download them are removed.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { disableArtifactsForBuild, getCleanableBuilds } from "../src/db/database.mjs";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildsDir = resolve(serverDir, "builds");

const retentionDays = Number(process.env.RETENTION_DAYS ?? 30);

if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
  console.error("RETENTION_DAYS must be a positive number.");
  process.exit(1);
}

const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

const cleanable = getCleanableBuilds(cutoff);

if (cleanable.length === 0) {
  console.log(`No builds older than ${retentionDays} day(s) to clean up.`);
  process.exit(0);
}

for (const { id } of cleanable) {
  const buildDir = resolve(buildsDir, id);

  rmSync(buildDir, { recursive: true, force: true });
  disableArtifactsForBuild(id);

  console.log(`Cleaned up: ${id}`);
}

console.log(`Cleaned up ${cleanable.length} build(s) older than ${retentionDays} day(s).`);
