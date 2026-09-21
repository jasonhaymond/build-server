# build-server

A self-hosted, project-agnostic build service. Android is the only
supported platform today, but the project is named `build-server` (not
`android-build-server`) because it's meant to grow to other platforms
later without another rename.

It accepts Android/Expo/React Native source and build configuration,
builds it in an isolated Docker container, stores the resulting APK/AAB,
and returns a permanent public download URL.

**Current version:** 1.0.0 — see [CHANGELOG.md](CHANGELOG.md) for release history.

Full architecture, API reference, security model, and the project roadmap
live in [PROJECT-SCOPE.md](PROJECT-SCOPE.md) — read that first for anything
beyond local setup. See [docs/deployment.md](docs/deployment.md) for
production deployment.

## Requirements

- Docker (runs both the API and the isolated Android build containers)
- Node.js 20+ (only needed to run the API outside of Docker Compose)

## Setup (Docker Compose — recommended)

```bash
node scripts/setup.mjs   # interactive, generates JOB_SECRETS_ENCRYPTION_KEY,
                          # detects DOCKER_GID, writes .env — safe to re-run

docker build -t build-server-android:latest .   # the Android build image
docker compose up -d --build                    # the API itself
```

The API container talks to the host's Docker daemon over a mounted socket
(Docker-outside-of-Docker) so it can launch isolated build containers —
see [docs/deployment.md](docs/deployment.md) for what that implies.

Create an API key (required for every authenticated endpoint):

```bash
docker compose exec api node scripts/create-api-key.mjs "some client name"
```

The plaintext key is printed once and is not recoverable afterward — only
its SHA-256 hash is stored. Save it somewhere real before continuing.

## Setup (without Docker Compose)

```bash
npm install
node scripts/setup.mjs   # answer "no" to the Docker Compose prompt
docker build -t build-server-android:latest .
node scripts/create-api-key.mjs "some client name"
npm run api
```

The worker (`npm run worker`) is spawned automatically per build by the API
— you don't run it standalone except for manual debugging.

## Submitting a build

```bash
curl -X POST http://localhost:8080/api/v1/builds \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "project": {
      "name": "Example",
      "source": { "type": "git", "url": "https://github.com/example/project.git", "ref": "main" }
    },
    "build": { "platform": "android", "variant": "release", "artifact": "apk" }
  }'
```

See [PROJECT-SCOPE.md](PROJECT-SCOPE.md) for the full API reference
(build status, logs, artifacts, permanent download URLs, cancellation,
API key management, metrics) and for the source-type/env/secrets schema.

## API keys and scopes

Keys created without `--scopes` get full access. Restrict a key with:

```bash
node scripts/create-api-key.mjs "ci-bot" --scopes build:create,build:read,build:logs,artifact:download
```

Known scopes: `build:create`, `build:read`, `build:read:any` (cross-tenant
ownership bypass — combine with `build:read`/`build:logs`/
`artifact:download`/`build:cancel` for the specific admin action needed),
`build:logs`, `build:cancel`, `artifact:download`, `artifact:manage`,
`api-key:manage`, `metrics:read`, `system:manage` (version/update/log
admin panel — see Deployment below). Builds are isolated per API key — a
key can only see/cancel/download its own builds unless it also holds
`build:read:any`.

## Deployment

Production runs behind a separate Caddy reverse proxy that terminates TLS.
Port 8080 must never be exposed directly to the Internet.

```bash
scripts/update.sh          # snapshot, pull, rebuild, restart, verify — one command
scripts/update.sh v1.2.3   # or deploy/roll back to a specific tag
node scripts/backup.mjs    # database + .env snapshot, on demand
npm run migrate            # explicit migration run (also happens automatically on boot)
```

`scripts/update.sh` also tags the rebuilt images with the running
`package.json` version (`build-server-api:vX.Y.Z`,
`build-server-android:vX.Y.Z`) alongside `:latest` — a speed optimization
for a schema-compatible rollback (redeploy a cached image instead of
rebuilding); the git tag remains the source of truth either way.

See [docs/deployment.md](docs/deployment.md) for the full first-deploy,
update, backup, and restore walkthrough, and
[PROJECT-SCOPE.md](PROJECT-SCOPE.md) for the reverse-proxy config, host
firewall rules, and architecture.

## Web UI (optional)

`web/` is a plain static dashboard (no build step) — submit builds, watch
status, view logs and artifacts, cancel a running build. It's served by
Caddy as its own site, separate from the API, so it needs `WEB_UI_ORIGIN`
set in `.env` for CORS. Sign-in is a manually-pasted API key kept only in
that browser tab's session storage.

A `system:manage`-scoped key also gets an **Admin** page: current version
vs. the latest GitHub tag (`GITHUB_REPO` in `.env`), a button that
triggers a real `scripts/update.sh` run (every safety guard intact —
uncommitted-changes check, pre-update snapshot, health-check poll) via a
sibling container spawned over the same Docker socket the build workers
already use, a "Back up now" button (same `scripts/backup.mjs` logic), a
build-metrics summary, and a tail of the API's own operational log.
Signing in only needs a *valid* key, not any particular scope, so an
admin-only key isn't locked out. See
[docs/deployment.md](docs/deployment.md#web-ui-optional) for the Caddy
config, `GITHUB_REPO`/`API_IMAGE` setup, and the update-trigger's
architecture.

## Status

v1.0.0: persistent build queue with restart recovery, artifact metadata,
API key scopes, build cancellation, retention cleanup, multi-tenant
isolation, structured logging, real health checks, Docker Compose
containerization, an automated test suite/CI, setup/update/backup
tooling, a web UI, and an admin panel with a working update-trigger
button are all in place and tested. See PROJECT-SCOPE.md's "Current Known
Limitations" section for what's still open (production alerting, a
dedicated build-runner replacing Docker-outside-of-Docker) before relying
on this at real scale.

## Running tests

```bash
npm test
```

Tests hit a real, isolated SQLite database per test file and spawn real
(small, non-Android) Docker containers for the restart-recovery tests —
nothing is mocked. Requires Docker to be running locally.
