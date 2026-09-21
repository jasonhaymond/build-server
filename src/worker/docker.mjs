import { resolve } from "node:path";

// Under Docker-outside-of-Docker (the API/worker container talks to the
// HOST daemon over a mounted socket), any bind-mount source path passed to
// `docker run` must be a HOST path — the daemon resolves it against the
// host filesystem, not the API container's. HOST_PROJECT_DIR is the
// host-side path to this deployment's root; when unset (a bare-metal,
// non-containerized deployment), the worker's own on-disk location
// already IS the host path.
export function resolveHostBuildDir(serverDir, jobId) {
  const hostRoot = process.env.HOST_PROJECT_DIR ?? serverDir;
  return resolve(hostRoot, "builds", jobId);
}

// The API/worker container's own UID (root, or a service account) has no
// relationship to the separately-daemon-managed build container's
// filesystem ownership — it must be pinned explicitly rather than derived
// from whatever the current process happens to run as.
export function resolveBuildContainerIds() {
  return {
    uid: process.env.BUILD_CONTAINER_UID ?? String(process.getuid?.() ?? 1000),
    gid: process.env.BUILD_CONTAINER_GID ?? String(process.getgid?.() ?? 1000),
  };
}
