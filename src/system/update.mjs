import { spawn } from "node:child_process";
import { createLogger } from "../logging/logger.mjs";

const logger = createLogger("system");

// Best-effort — a public GitHub repo's tags list, no auth needed. Degrades
// to "couldn't check" rather than failing the whole status endpoint if the
// network call fails or GITHUB_REPO isn't configured.
export async function checkLatestVersion(currentVersion) {
  const repo = process.env.GITHUB_REPO;

  if (!repo) {
    return { latestVersion: null, checked: false, updateAvailable: false };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags`, {
      headers: { "User-Agent": "build-server" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const tags = await res.json();
    const latestVersion = tags[0]?.name?.replace(/^v/, "") ?? null;

    return {
      latestVersion,
      checked: true,
      updateAvailable: Boolean(latestVersion) && latestVersion !== currentVersion,
    };
  } catch (error) {
    logger.warn("Could not check for updates", { error: error.message });
    return { latestVersion: null, checked: false, updateAvailable: false, error: error.message };
  }
}

// The API container only has its own source baked into its image — not
// the live git repo, docker-compose.yml, or scripts/ as a directory tree
// — so it can't run `git pull` / `docker compose up` on itself directly.
// Instead it spawns a short-lived sibling container (same image, via the
// same DooD socket it already uses for build containers) with the full
// host project directory bind-mounted at its real host path, and runs the
// real scripts/update.sh inside that — every safety guard in that script
// (uncommitted-changes check, pre-update snapshot, health-check poll)
// applies exactly as it would over SSH. --network host so the script's
// own health-check curl can reach the restarted service's published port.
export function buildUpdateRunnerArgs({ hostProjectDir, apiImage, targetRef, runnerName }) {
  if (!hostProjectDir || !apiImage) {
    throw new Error(
      "HOST_PROJECT_DIR and API_IMAGE must be set to trigger an update this way (Docker Compose deployments only).",
    );
  }

  return [
    "run", "--rm", "-d",
    "--name", runnerName,
    "--network", "host",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${hostProjectDir}:${hostProjectDir}`,
    "-w", hostProjectDir,
    apiImage,
    "bash", "scripts/update.sh",
    ...(targetRef ? [targetRef] : []),
  ];
}

export function triggerUpdate({ targetRef } = {}) {
  const runnerName = `build-server-update-${Date.now()}`;

  const args = buildUpdateRunnerArgs({
    hostProjectDir: process.env.HOST_PROJECT_DIR,
    apiImage: process.env.API_IMAGE,
    targetRef,
    runnerName,
  });

  logger.info("Triggering update", { targetRef: targetRef ?? "latest", runnerName });

  const child = spawn("docker", args, { stdio: "ignore", detached: true });
  child.unref();

  return { runnerName, targetRef: targetRef ?? "latest" };
}
