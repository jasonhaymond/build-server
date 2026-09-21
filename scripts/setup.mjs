#!/usr/bin/env node

// Interactive, idempotent .env setup. Safe to re-run: asks before
// overwriting anything that already exists, and never redisplays a
// previously-generated secret.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(serverDir, ".env");

// readline/promises' question() hangs on the second call against
// non-TTY/piped stdin on some Node versions — the callback API doesn't
// have that problem, so it's wrapped here instead.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function rlQuestion(prompt) {
  return new Promise((resolvePromise) => rl.question(prompt, resolvePromise));
}

async function ask(question, defaultValue) {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
  const answer = (await rlQuestion(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(question, defaultYes) {
  const answer = await ask(`${question} (yes/no)`, defaultYes ? "yes" : "no");
  return answer.toLowerCase().startsWith("y");
}

function parseEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function isPortInUse(port) {
  return new Promise((resolvePromise) => {
    const tester = createServer()
      .once("error", () => resolvePromise(true))
      .once("listening", () => tester.close(() => resolvePromise(false)))
      .listen(port, "0.0.0.0");
  });
}

// Only a NEW deployment (or picking a different port than what's already
// recorded) needs this check — a port this same deployment already owns
// from a prior run isn't a conflict, it's just itself.
async function choosePort(defaultPort, isNewPort) {
  let port = await ask("Port the API listens on", defaultPort);

  if (!isNewPort(port)) {
    return port;
  }

  while (await isPortInUse(Number(port))) {
    console.log("");
    console.log(`Port ${port} already has something listening on it on this host.`);
    const useAnyway = await askYesNo("Use it anyway?", false);

    if (useAnyway) {
      break;
    }

    port = await ask("Enter a different port", undefined);
  }

  return port;
}

function detectDockerGid() {
  try {
    return execFileSync("getent", ["group", "docker"], { encoding: "utf8" })
      .trim()
      .split(":")[2];
  } catch {
    return undefined;
  }
}

const existing = parseEnvFile(envPath);

if (existsSync(envPath)) {
  const overwrite = await askYesNo(`${envPath} already exists. Overwrite it?`, false);

  if (!overwrite) {
    console.log("Keeping the existing .env. Nothing was changed.");
    rl.close();
    process.exit(0);
  }
}

console.log("");
console.log("=== build-server setup ===");
console.log("");

const port = await choosePort(
  existing.PORT ?? "8080",
  (candidate) => candidate !== existing.PORT,
);
const publicBaseUrl = await ask(
  "Public base URL (behind your reverse proxy)",
  existing.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
);

let secretsKey = existing.JOB_SECRETS_ENCRYPTION_KEY;

if (secretsKey) {
  console.log("Keeping the existing JOB_SECRETS_ENCRYPTION_KEY (not shown).");
} else {
  secretsKey = randomBytes(32).toString("hex");
  console.log("Generated a new JOB_SECRETS_ENCRYPTION_KEY.");
  console.log("IMPORTANT: back up your .env file now — this key is shown only this once");
  console.log("and cannot be recovered later, only rotated (which loses any build still");
  console.log("genuinely queued at rotation time).");
}

const androidImage = await ask("Android build image tag", existing.ANDROID_BUILD_IMAGE ?? "build-server-android:latest");
const buildTimeoutMs = await ask("Build timeout in ms", existing.BUILD_TIMEOUT_MS ?? "7200000");
const allowLocalGit = await askYesNo(
  "Allow local filesystem Git sources? (trusted/internal deployments only)",
  existing.ALLOW_LOCAL_GIT_SOURCES === "true",
);
const githubRepo = await ask(
  "GitHub repo (owner/repo) to check for newer versions — blank to skip",
  existing.GITHUB_REPO ?? "",
);

const useCompose = await askYesNo("Deploy with Docker Compose?", true);

const lines = [
  `PORT=${port}`,
  `PUBLIC_BASE_URL=${publicBaseUrl}`,
  `ANDROID_BUILD_IMAGE=${androidImage}`,
  `JOB_SECRETS_ENCRYPTION_KEY=${secretsKey}`,
  `BUILD_TIMEOUT_MS=${buildTimeoutMs}`,
  `ALLOW_LOCAL_GIT_SOURCES=${allowLocalGit}`,
  ...(githubRepo ? [`GITHUB_REPO=${githubRepo}`] : []),
];

if (useCompose) {
  const hostProjectDir = await ask(
    "Absolute HOST path to this deployment directory (see docs/deployment.md)",
    existing.HOST_PROJECT_DIR ?? serverDir,
  );

  const detectedGid = detectDockerGid();
  const dockerGid = await ask(
    "Host docker group GID (for the API container to access the mounted socket)",
    existing.DOCKER_GID ?? detectedGid ?? "",
  );

  const buildUid = await ask("Android build container UID", existing.BUILD_CONTAINER_UID ?? "1000");
  const buildGid = await ask("Android build container GID", existing.BUILD_CONTAINER_GID ?? "1000");

  lines.push(
    "",
    "# Docker Compose deployment",
    `HOST_PROJECT_DIR=${hostProjectDir}`,
    `BUILD_CONTAINER_UID=${buildUid}`,
    `BUILD_CONTAINER_GID=${buildGid}`,
    `DOCKER_GID=${dockerGid}`,
  );

  if (!dockerGid) {
    console.log("");
    console.log("Warning: could not determine DOCKER_GID automatically (getent not found or");
    console.log("no docker group). Set it manually in .env before running docker compose up —");
    console.log("find it with: getent group docker | cut -d: -f3");
  }
}

writeFileSync(envPath, `${lines.join("\n")}\n`);

console.log("");
console.log(`Wrote ${envPath}`);
console.log("");
console.log(
  useCompose
    ? "Next: docker build -t " + androidImage + " . && docker compose up -d --build"
    : "Next: docker build -t " + androidImage + " . && npm install && npm run api",
);

rl.close();
