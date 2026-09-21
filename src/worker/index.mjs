#!/usr/bin/env node

import {
  appendFileSync,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import yauzl from "yauzl";
import { validateGitSource } from "../security/gitSource.mjs";
import { registerArtifact } from "./artifacts.mjs";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildsDir = resolve(serverDir, "builds");
const dockerImage = process.env.ANDROID_BUILD_IMAGE ?? "android-build-server:latest";

const jobPath = process.argv[2];

let job;

try {
  if (jobPath) {
    const resolvedJobPath = resolve(jobPath);

    if (!existsSync(resolvedJobPath)) {
      console.error(`Job file not found: ${resolvedJobPath}`);
      process.exit(1);
    }

    job = JSON.parse(readFileSync(resolvedJobPath, "utf8"));
  } else {
    const chunks = [];

    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    const input = Buffer.concat(chunks).toString("utf8").trim();

    if (!input) {
      console.error("No job supplied.");
      console.error("Usage: npm run worker -- <job.json>");
      console.error("Or pipe a JSON job through stdin.");
      process.exit(1);
    }

    job = JSON.parse(input);
  }
} catch (error) {
  console.error(`Could not read build job: ${error.message}`);
  process.exit(1);
}

/*
 * ------------------------------------------------------------
 * Validate job
 * ------------------------------------------------------------
 */

const errors = [];

if (!job.id) {
  errors.push("job.id is required");
}

if (!job.project?.name) {
  errors.push("project.name is required");
}

if (!["directory", "upload", "git"].includes(job.project?.source?.type)) {
  errors.push("project.source.type must be directory, upload, or git");
}

if (job.project?.source?.type !== "git" && !job.project?.source?.path) {
  errors.push("project.source.path is required for directory and upload sources");
}

if (job.project?.source?.type === "git" && !job.project.source.url) {
  errors.push("project.source.url is required for git sources");
}

if (job.build?.platform !== "android") {
  errors.push("Only Android builds are currently supported");
}

if (!["apk", "aab"].includes(job.build?.artifact)) {
  errors.push("build.artifact must be either apk or aab");
}

if (!["debug", "release"].includes(job.build?.variant)) {
  errors.push("build.variant must be either debug or release");
}

if (errors.length > 0) {
  console.error("Invalid build job:");

  for (const error of errors) {
    console.error(`  - ${error}`);
  }

  process.exit(1);
}

/*
 * ------------------------------------------------------------
 * Job directories
 * ------------------------------------------------------------
 */

const jobDir = resolve(buildsDir, job.id);
const sourceDir = resolve(jobDir, "source");
const workDir = resolve(jobDir, "work");
const artifactsDir = resolve(jobDir, "artifacts");
const logsDir = resolve(jobDir, "logs");

const buildLogPath = resolve(logsDir, "build.log");

mkdirSync(sourceDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

const persistedJob = {
  ...job,
  build: job.build
    ? {
        ...job.build,
        secrets: job.build.secrets
          ? Object.fromEntries(
              Object.keys(job.build.secrets).map((name) => [name, "***"]),
            )
          : undefined,
      }
    : job.build,
};

writeFileSync(
  resolve(jobDir, "job.json"),
  `${JSON.stringify(persistedJob, null, 2)}\n`,
);

/*
 * ------------------------------------------------------------
 * Logging
 * ------------------------------------------------------------
 */

function log(message = "") {
  console.log(message);
  appendFileSync(buildLogPath, `${message}\n`);
}

function logError(message = "") {
  console.error(message);
  appendFileSync(buildLogPath, `${message}\n`);
}

writeFileSync(buildLogPath, "");

/*
 * ------------------------------------------------------------
 * Stage source
 * ------------------------------------------------------------
 */

const sourceType = job.project.source.type;
const sourceInputPath = sourceType === "git"
  ? resolve(workDir, "git-source")
  : resolve(job.project.source.path);

if (sourceType !== "git" && !existsSync(sourceInputPath)) {
  logError(`Source path not found: ${sourceInputPath}`);
  process.exit(1);
}

if (sourceType === "directory" && !statSync(sourceInputPath).isDirectory()) {
  logError(`Source path is not a directory: ${sourceInputPath}`);
  process.exit(1);
}

if (sourceType === "upload" && (!statSync(sourceInputPath).isFile() || !sourceInputPath.toLowerCase().endsWith(".zip"))) {
  logError(`Upload source must be an existing .zip file: ${sourceInputPath}`);
  process.exit(1);
}

if (sourceType === "git") {
  try {
    await validateGitSource(job.project.source, {
      allowLocal: process.env.ALLOW_LOCAL_GIT_SOURCES === "true",
    });
  } catch (error) {
    logError(`Git source rejected: ${error.message}`);
    process.exit(1);
  }

  log("=== Cloning Git repository ===");
  log(`Repository: ${job.project.source.url}`);
  log(`Destination: ${sourceInputPath}`);

  const gitArgs = ["clone"];

  if (job.project.source.ref) {
    gitArgs.push("--branch", job.project.source.ref);
  }

  gitArgs.push("--depth", "1", job.project.source.url, sourceInputPath);

  try {
    execFileSync("git", gitArgs, {
      stdio: "inherit",
    });
  } catch (error) {
    logError(`Git clone failed: ${error.message}`);
    process.exit(1);
  }

  log("Git clone completed.");
  log("");
}
async function extractZipSafely(zipPath, destination) {
  const zipfile = await new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: false },
      (error, file) => (error ? rejectPromise(error) : resolvePromise(file)),
    );
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      zipfile.on("error", rejectPromise);
      zipfile.on("end", resolvePromise);

      zipfile.on("entry", (entry) => {
        handleEntry(entry).then(
          () => zipfile.readEntry(),
          (error) => rejectPromise(error),
        );
      });

      zipfile.readEntry();

      async function handleEntry(entry) {
        const normalized = entry.fileName.replace(/\\/g, "/");

        if (
          normalized.startsWith("/") ||
          /^[A-Za-z]:\//.test(normalized) ||
          normalized.split("/").includes("..")
        ) {
          throw new Error(`Unsafe ZIP entry path: ${entry.fileName}`);
        }

        // High byte of versionMadeBy is the "host OS" that produced the
        // entry; Unix (3) packs the file mode into the top 16 bits of
        // externalFileAttributes. Only trust it as a symlink check when
        // the entry actually claims to come from a Unix zip writer.
        const isUnixEntry = (entry.versionMadeBy >>> 8) === 3;
        const unixMode = isUnixEntry
          ? (entry.externalFileAttributes >>> 16) & 0xffff
          : 0;

        if ((unixMode & 0xf000) === 0xa000) {
          throw new Error(`Symlink ZIP entries are not allowed: ${entry.fileName}`);
        }

        const entryPath = resolve(destination, normalized);

        if (normalized.endsWith("/")) {
          mkdirSync(entryPath, { recursive: true });
          return;
        }

        mkdirSync(dirname(entryPath), { recursive: true });

        const readStream = await new Promise((resolveStream, rejectStream) => {
          zipfile.openReadStream(entry, (error, stream) =>
            error ? rejectStream(error) : resolveStream(stream),
          );
        });

        await pipeline(readStream, createWriteStream(entryPath));
      }
    });
  } finally {
    zipfile.close();
  }
}

const sourcePath = sourceType === "directory"
  ? sourceInputPath
  : sourceType === "upload"
    ? resolve(workDir, "uploaded-source")
    : sourceInputPath;

mkdirSync(sourcePath, { recursive: true });

if (sourceType === "upload") {
  log("=== Extracting uploaded source ===");
  log(`Archive: ${sourceInputPath}`);
  log(`Extracting to: ${sourcePath}`);

  try {
    await extractZipSafely(sourceInputPath, sourcePath);
  } catch (error) {
    logError(`ZIP extraction failed: ${error.message}`);
    process.exit(1);
  }

  log("ZIP extraction completed.");
  log("");
}

function shouldExcludePath(src) {
  const rel = relative(sourcePath, src);

  if (!rel || rel === "") {
    return false;
  }

  const parts = rel.split(/[\\/]/);

  for (const part of parts) {
    if (
      part === "node_modules" ||
      part === ".git" ||
      part === ".gradle"
    ) {
      return true;
    }

    if (
      part === ".env" ||
      part.startsWith(".env.")
    ) {
      return true;
    }

    if (
      part.endsWith(".dump") ||
      part.endsWith(".backup")
    ) {
      return true;
    }
  }

  return false;
}

log("=== Android Build Worker ===");
log("");
log(`Job ID:       ${job.id}`);
log(`Project:      ${job.project.name}`);
log(`Source:       ${sourcePath}`);
log(`Project root: ${job.project.projectRoot ?? "."}`);
log(`Platform:     ${job.build.platform}`);
log(`Variant:      ${job.build.variant}`);
log(`Artifact:     ${job.build.artifact}`);
log(`Docker image: ${dockerImage}`);
log("");

log("=== Staging source ===");

cpSync(sourcePath, sourceDir, {
  recursive: true,
  filter: (src) => !shouldExcludePath(src),
});

log(`Source staged at: ${sourceDir}`);
log("");

/*
 * ------------------------------------------------------------
 * Determine project root
 * ------------------------------------------------------------
 */

const projectRootRelative = job.project.projectRoot ?? ".";
const projectRoot = resolve(sourceDir, projectRootRelative);

if (!existsSync(projectRoot)) {
  logError(`Project root does not exist: ${projectRoot}`);
  process.exit(1);
}

if (!existsSync(join(projectRoot, "package.json"))) {
  logError(`No package.json found at project root: ${projectRoot}`);
  process.exit(1);
}

/*
 * ------------------------------------------------------------
 * Docker execution
 * ------------------------------------------------------------
 */

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

const gradleTask =
  job.build.artifact === "aab"
    ? "bundle"
    : "assemble";

const gradleVariant =
  job.build.variant.charAt(0).toUpperCase() +
  job.build.variant.slice(1);

const containerProjectRoot = `/build/job/source/${projectRootRelative === "." ? "" : `${projectRootRelative}/`}`;

const artifactRelativePath =
  job.build.artifact === "apk"
    ? `app/build/outputs/apk/${job.build.variant}/app-${job.build.variant}.apk`
    : `app/build/outputs/bundle/${job.build.variant}/app-${job.build.variant}.aab`;

const safeProjectName = job.project.name.replace(
  /[^a-zA-Z0-9._-]+/g,
  "-",
);

const artifactDestination = resolve(
  artifactsDir,
  `${safeProjectName}-${job.build.variant}.${job.build.artifact}`,
);

// Platform-prefixed so builds for other platforms (added later) can't
// collide on container names, and so a build's container can be found by
// name after a restart (used for the timeout below, and for recovery).
const containerName = `build-${job.build.platform}-${job.id}`;

const buildTimeoutMs = Number(process.env.BUILD_TIMEOUT_MS ?? 2 * 60 * 60 * 1000);

const containerCommand = `
set -e

echo "=== Toolchain ==="
node --version
npm --version
java -version
sdkmanager --version

echo
echo "=== Installing dependencies ==="
cd "${containerProjectRoot}"
npm install

echo
echo "=== Generating Android project ==="
NODE_ENV=production npx expo prebuild --clean --platform android

if [ ! -d android ]; then
  echo "ERROR: Expo prebuild did not create an android directory."
  exit 1
fi

echo
echo "=== Configuring Gradle memory ==="

if [ -f android/gradle.properties ]; then
  sed -i '/^org.gradle.jvmargs=/d' android/gradle.properties
fi

printf '\n%s\n' \
  'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g' \
  >> android/gradle.properties


echo
echo "=== Building Android artifact ==="
cd android

./gradlew ${gradleTask}${gradleVariant} --stacktrace

echo
echo "=== Verifying artifact ==="

if [ ! -f "${artifactRelativePath}" ]; then
  echo "ERROR: Expected artifact was not found:"
  echo "${artifactRelativePath}"
  exit 1
fi

echo
echo "=== BUILD COMPLETE ==="
ls -lh "${artifactRelativePath}"
`;

log("=== Starting isolated Docker build ===");
log("");
log(`Container UID/GID: ${uid}:${gid}`);
log("");

const buildEnv = job.build?.env ?? {};
const buildSecrets = job.build?.secrets ?? {};

function validateEnvironmentObject(value, fieldName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    logError(`${fieldName} must be an object containing environment variable names and values.`);
    process.exit(1);
  }
}

function validateEnvironmentName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    logError(`Invalid environment variable name: ${name}`);
    process.exit(1);
  }
}

function validateEnvironmentValue(name, value, fieldName) {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    logError(
      `${fieldName} variable "${name}" must have a string, number, or boolean value.`
    );
    process.exit(1);
  }
}

validateEnvironmentObject(buildEnv, "build.env");
validateEnvironmentObject(buildSecrets, "build.secrets");

const environmentArgs = [];

for (const [name, value] of Object.entries(buildEnv)) {
  validateEnvironmentName(name);
  validateEnvironmentValue(name, value, "Environment");
  environmentArgs.push("-e", `${name}=${String(value)}`);
}

for (const [name, value] of Object.entries(buildSecrets)) {
  validateEnvironmentName(name);
  validateEnvironmentValue(name, value, "Secret");
  environmentArgs.push("-e", `${name}=${String(value)}`);
}

const dockerArgs = [
  "run",
  "--rm",

  "--name",
  containerName,

  "--user",
  `${uid}:${gid}`,

  "--cpus",
  "6",

  "--memory",
  "12g",

  "--pids-limit",
  "512",

  "--security-opt",
  "no-new-privileges",

  "-e",
  `HOME=/build/job/work/home`,

  "-e",
  "GRADLE_USER_HOME=/build/job/work/gradle-cache",

  "-e",
  "NODE_ENV=production",

  ...environmentArgs,

  "-v",
  `${jobDir}:/build/job`,

  dockerImage,

  "bash",
  "-lc",
  containerCommand,
];

const loggedDockerArgs = dockerArgs.map((arg, index) => {
  if (index > 0 && dockerArgs[index - 1] === "-e") {
    const equalsIndex = arg.indexOf("=");

    if (equalsIndex !== -1) {
      return `${arg.slice(0, equalsIndex + 1)}***`;
    }
  }

  return arg;
});

log(`$ docker ${loggedDockerArgs.join(" ")}`);
log("");

function runDocker() {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", dockerArgs, {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;

      logError("");
      logError(`=== BUILD TIMEOUT ===`);
      logError(`Build exceeded ${buildTimeoutMs}ms and is being terminated.`);

      try {
        execFileSync("docker", ["kill", containerName], { stdio: "ignore" });
      } catch {
        // Container may have already exited on its own; nothing more to do.
      }
    }, buildTimeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      appendFileSync(buildLogPath, text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      appendFileSync(buildLogPath, text);
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      logError(`Failed to start Docker: ${error.message}`);
      resolvePromise({ code: 1, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      resolvePromise({ code: code ?? 1, timedOut });
    });
  });
}

const { code: exitCode, timedOut } = await runDocker();

if (exitCode !== 0) {
  log("");
  logError(timedOut ? "=== BUILD FAILED (timeout) ===" : "=== BUILD FAILED ===");
  logError(`Docker exited with code ${exitCode}`);
  process.exit(exitCode);
}

/*
 * ------------------------------------------------------------
 * Copy artifact out of the container workspace
 * ------------------------------------------------------------
 */

const containerArtifact = resolve(
  projectRoot,
  "android",
  artifactRelativePath,
);

if (!existsSync(containerArtifact)) {
  logError("");
  logError(`Build succeeded, but artifact was not found:`);
  logError(containerArtifact);
  process.exit(1);
}

cpSync(containerArtifact, artifactDestination);

const { size: artifactSize } = registerArtifact({
  buildId: job.id,
  filename: artifactDestination.split(/[\\/]/).pop(),
  type: job.build.artifact,
  path: artifactDestination,
});

const sizeMb = (artifactSize / (1024 * 1024)).toFixed(1);

log("");
log("=== BUILD COMPLETE ===");
log("");
log(`Artifact: ${artifactDestination}`);
log(`Size:     ${sizeMb} MB`);
log(`Log:      ${buildLogPath}`);
