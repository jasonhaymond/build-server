import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const logPath = resolve(serverDir, "logs", "api.log");

// The API's own operational log (see src/logging/logger.mjs) — distinct
// from a build's per-build log, which is already served by
// GET /api/v1/builds/:id/logs. Tail-only, no pagination: this is meant
// for "what's happening right now," not archival browsing.
export function tailApiLog({ lines = 200, level } = {}) {
  if (!existsSync(logPath)) {
    return [];
  }

  const allLines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);

  const entries = allLines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, level: "info", source: "unknown", msg: line };
      }
    })
    .filter((entry) => !level || entry.level === level);

  return entries.slice(-lines);
}
