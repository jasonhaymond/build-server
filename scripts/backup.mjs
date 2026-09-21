#!/usr/bin/env node

import { runBackup } from "../src/system/backup.mjs";

try {
  const { archivePath, version, envIncluded } = runBackup();

  console.log(`Backup written: ${archivePath}`);
  console.log(`App version at backup time: ${version}`);

  if (!envIncluded) {
    console.warn("Warning: .env not found — backup did not include it.");
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
