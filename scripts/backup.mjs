#!/usr/bin/env node

// Plain SQLite snapshot + tar.gz — the manual-fallback tier the project's
// backup standard allows for a smaller project (a full Borg-based setup
// is the eventual target, not built yet). Backs up the database AND the
// env file together, since secrets in .env can't be regenerated. Named
// after the version actually recorded in app_meta (upserted on every
// boot), not package.json on disk, so the filename reflects what was
// really running when the snapshot was taken.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getAppMeta } from "../src/db/database.mjs";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(serverDir, "data", "build-server.db");
const envPath = resolve(serverDir, ".env");
const backupsDir = resolve(serverDir, "backups");

if (!existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath} — nothing to back up.`);
  process.exit(1);
}

mkdirSync(backupsDir, { recursive: true });

const meta = getAppMeta();
const version = meta?.version ?? "unknown";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

const stagingDir = resolve(backupsDir, `.staging-${timestamp}`);
mkdirSync(stagingDir, { recursive: true });

try {
  const snapshotDbPath = resolve(stagingDir, "build-server.db");

  // VACUUM INTO produces a single consistent snapshot file and is safe
  // to run against a live database.
  const db = new Database(dbPath, { readonly: true });
  db.prepare("VACUUM INTO ?").run(snapshotDbPath);
  db.close();

  if (existsSync(envPath)) {
    execFileSync("cp", [envPath, resolve(stagingDir, ".env")]);
  } else {
    console.warn("Warning: .env not found — backup will not include it.");
  }

  const archiveName = `build-server-v${version}-${timestamp}.tar.gz`;
  const archivePath = resolve(backupsDir, archiveName);

  execFileSync("tar", ["-czf", archivePath, "-C", stagingDir, "."]);

  console.log(`Backup written: ${archivePath}`);
  console.log(`App version at backup time: ${version}`);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
