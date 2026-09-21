#!/usr/bin/env bash
# One-command update: snapshot, pull/checkout, install, migrate, rebuild,
# restart, verify. Refuses to run over uncommitted local changes so it can
# never silently overwrite server-side state.
#
# Usage:
#   scripts/update.sh              # update to the latest commit on the current branch
#   scripts/update.sh v1.2.3       # deploy/roll back to a specific tag
#
# Code rollback this way is always safe and fully reproducible. Database
# rollback is not — see docs/deployment.md's "Rolling back" section before
# using this to go backward across a schema-changing release.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to update: uncommitted local changes present." >&2
  echo "Commit, stash, or discard them first, then re-run." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo ".env not found — run 'node scripts/setup.mjs' first." >&2
  exit 1
fi

TARGET_REF="${1:-}"

echo "== Snapshotting database and .env before update =="
# Run inside the (still-running, pre-update) api container rather than
# bare on the host: backup.mjs needs better-sqlite3's native module,
# which this host was never expected to have installed on its own — only
# the container's image builds it. -T disables TTY allocation since this
# runs non-interactively.
docker compose exec -T api node scripts/backup.mjs

if [[ -n "$TARGET_REF" ]]; then
  echo "== Fetching and checking out $TARGET_REF =="
  git fetch --tags
  git checkout "$TARGET_REF"
else
  echo "== Pulling latest on the current branch =="
  git pull
fi

ANDROID_IMAGE="$(grep -E '^ANDROID_BUILD_IMAGE=' .env | cut -d= -f2-)"
ANDROID_IMAGE="${ANDROID_IMAGE:-build-server-android:latest}"
ANDROID_IMAGE_BASE="${ANDROID_IMAGE%%:*}"

VERSION="$(node -p "require('./package.json').version")"

echo "== Building the Android build image ($ANDROID_IMAGE) =="
docker build -t "$ANDROID_IMAGE" -t "${ANDROID_IMAGE_BASE}:v${VERSION}" .

echo "== Rebuilding and restarting the API (Docker Compose) =="
docker compose build
# Version-tagged alongside :latest — a speed optimization for a
# schema-compatible rollback (redeploy a cached image instead of
# rebuilding from source). The git tag remains the source of truth;
# image caches get pruned, a git tag doesn't.
docker tag build-server-api:latest "build-server-api:v${VERSION}"
docker compose up -d
# SQLite migrations run automatically on API startup (src/db/migrate.mjs)
# — non-interactive and forward-only, no separate step needed here.

echo "== Waiting for the health check =="
PORT="$(grep -E '^PORT=' .env | cut -d= -f2-)"
PORT="${PORT:-8080}"

for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/health" > /dev/null; then
    echo "Update complete — service is healthy on port ${PORT}."
    exit 0
  fi
  sleep 2
done

echo "Service did not become healthy within 60s." >&2
echo "Check: docker compose logs api" >&2
exit 1
