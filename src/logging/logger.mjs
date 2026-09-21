import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const logsDir = resolve(serverDir, "logs");
const logPath = resolve(logsDir, "api.log");

const maxLogSizeBytes = Number(process.env.LOG_MAX_SIZE_BYTES ?? 10 * 1024 * 1024);
const SECRET_KEY_PATTERN = /secret|token|key/i;

mkdirSync(logsDir, { recursive: true });

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "***" : redact(v),
      ]),
    );
  }

  return value;
}

// Simple single-file size-based rotation — one backup, no external
// dependency. Good enough for a single-process app; a project running
// under pm2/systemd could rely on those instead (see docs/deployment.md).
function rotateIfNeeded() {
  if (!existsSync(logPath) || statSync(logPath).size < maxLogSizeBytes) {
    return;
  }

  renameSync(logPath, `${logPath}.1`);
}

function write(level, source, msg, extra) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    source,
    msg,
    ...(extra ? redact(extra) : {}),
  };

  const line = `${JSON.stringify(entry)}\n`;

  (level === "error" ? process.stderr : process.stdout).write(line);

  rotateIfNeeded();
  appendFileSync(logPath, line);
}

export function createLogger(source) {
  return {
    info: (msg, extra) => write("info", source, msg, extra),
    warn: (msg, extra) => write("warn", source, msg, extra),
    error: (msg, extra) => write("error", source, msg, extra),
  };
}
