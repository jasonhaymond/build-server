# build-server

A self-hosted, project-agnostic build service. Android is the only
supported platform today, but the project is named `build-server` (not
`android-build-server`) because it's meant to grow to other platforms
later without another rename.

It accepts Android/Expo/React Native source and build configuration,
builds it in an isolated Docker container, stores the resulting APK/AAB,
and returns a permanent public download URL.

**Current version:** 0.9.0 — see [CHANGELOG.md](CHANGELOG.md) for release history.

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
`api-key:manage`, `metrics:read`. Builds are isolated per API key — a key
can only see/cancel/download its own builds unless it also holds
`build:read:any`.

## Deployment

Production runs behind a separate Caddy reverse proxy that terminates TLS.
Port 8080 must never be exposed directly to the Internet.

```bash
scripts/update.sh          # snapshot, pull, rebuild, restart, verify — one command
scripts/update.sh v1.2.3   # or deploy/roll back to a specific tag
node scripts/backup.mjs    # database + .env snapshot, on demand
```

See [docs/deployment.md](docs/deployment.md) for the full first-deploy,
update, backup, and restore walkthrough, and
[PROJECT-SCOPE.md](PROJECT-SCOPE.md) for the reverse-proxy config, host
firewall rules, and architecture.

## Status

Actively-hardening (v0.9.0): persistent build queue with restart recovery,
artifact metadata, API key scopes, build cancellation, retention cleanup,
multi-tenant isolation, structured logging, real health checks, Docker
Compose containerization, an automated test suite/CI, and setup/update/
backup tooling are all in place. See PROJECT-SCOPE.md's "Current Known
Limitations" section for what's still ahead (a web UI, chiefly) before
relying on this for anything beyond internal/trusted use.

## Running tests

```bash
npm test
```

Tests hit a real, isolated SQLite database per test file and spawn real
(small, non-Android) Docker containers for the restart-recovery tests —
nothing is mocked. Requires Docker to be running locally.
