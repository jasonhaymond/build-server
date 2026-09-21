#!/usr/bin/env node

// Migrations already run automatically whenever database.mjs is imported
// (API boot, worker, backup/cleanup scripts) — this just gives deploy
// scripts/CI an explicit, discrete command to invoke non-interactively,
// per the project's migration standard, without booting the whole API.
import { getAppMeta } from "../src/db/database.mjs";

const meta = getAppMeta();

console.log("Migrations applied.");

if (meta) {
  console.log(`Database was last booted at app version ${meta.version} (${meta.updatedAt}).`);
}
