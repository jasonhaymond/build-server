// Plain SQLite snapshot + tar.gz — the manual-fallback tier the project's
// backup standard allows for a smaller project (a full Borg-based setup
// is the eventual target, not built yet). Backs up the database AND the
// env file together, since secrets in .env can't be regenerated. Named
// after the version actually recorded in app_meta (upserted on every
// boot), not package.json on disk, so the filename reflects what was
// really running when the snapshot was taken.
//
// Shared by scripts/backup.mjs (CLI/cron) and the web UI's Admin "Back up
// now" button (POST /api/v1/system/backup) — one implementation, two
// callers, per the project's standard of keeping automation to a single
// source of truth.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getAppMeta } from "../db/database.mjs";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function runBackup() {
  const dbPath = process.env.DB_PATH
    ? resolve(process.env.DB_PATH)
    : resolve(serverDir, "data", "build-server.db");
  const envPath = resolve(serverDir, ".env");
  const backupsDir = resolve(serverDir, "backups");

  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath} — nothing to back up.`);
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

    let envIncluded = true;

    if (existsSync(envPath)) {
      execFileSync("cp", [envPath, resolve(stagingDir, ".env")]);
    } else {
      envIncluded = false;
    }

    const archiveName = `build-server-v${version}-${timestamp}.tar.gz`;
    const archivePath = resolve(backupsDir, archiveName);

    execFileSync("tar", ["-czf", archivePath, "-C", stagingDir, "."]);

    return { archivePath, version, envIncluded };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
