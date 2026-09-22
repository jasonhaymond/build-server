# build-server

A self-hosted, project-agnostic build service. Android is the only
supported platform today, but the project is named `build-server` (not
`android-build-server`) because it's meant to grow to other platforms
later without another rename.

It accepts Android/Expo/React Native source and build configuration,
builds it in an isolated Docker container, stores the resulting APK/AAB,
and returns a permanent public download URL.

**Current version:** 2.1.0 — see [CHANGELOG.md](CHANGELOG.md) for release history.

Architecture rationale, the source/build request schema, and the security
model live in [PROJECT-SCOPE.md](PROJECT-SCOPE.md) (the original handoff
spec — still accurate for those, though its own status sections are
historical). For the current, complete endpoint-by-endpoint reference,
see [docs/api-reference.md](docs/api-reference.md). See
[docs/deployment.md](docs/deployment.md) for production deployment.

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

Bootstrap the first admin account (real username/password + mandatory
TOTP sign-in — separate from API keys, see API keys below):

```bash
docker compose exec api node scripts/create-user.mjs
```

Sign into the web UI with it (walks you through 2FA enrollment), then
create everything else — invites for other accounts, your own API
keys — from there. Or create a standalone API key directly, for
scripted/CI use with no user attached:

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
node scripts/create-user.mjs   # bootstrap the first admin account
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

See [docs/api-reference.md](docs/api-reference.md) for the full endpoint
reference (build status, logs, artifacts, permanent download URLs,
cancellation, API key management, metrics, the admin/system endpoints)
and [PROJECT-SCOPE.md](PROJECT-SCOPE.md) for the source-type/env/secrets
schema in more depth.

## API keys and scopes

API keys are a narrower, separate thing from a real account — meant for
scripted/CI access, never for signing into the web UI or reaching any
admin action (server updates/backups/logs, user/invite management, and
broadcasts are pure signed-in-admin-session checks now, not satisfiable
via a key at all). A key created from a user's own profile in the web UI
is tied to that user — its builds are that user's builds, in that user's
workspace, isolated from every other account including admins. A key
created with `scripts/create-api-key.mjs` (no user attached) keeps
working exactly like every key did before accounts existed — unowned,
its own isolated bucket.

Keys created without `--scopes` get full access to the remaining
(non-admin) actions. Restrict a key with:

```bash
node scripts/create-api-key.mjs "ci-bot" --scopes build:create,build:read,build:logs,artifact:download
```

Known scopes: `build:create`, `build:read`, `build:logs`, `build:cancel`,
`artifact:download`, `artifact:manage`, `metrics:read`. Isolation is
absolute — a key only ever sees/cancels/downloads its own builds, full
stop; there is no scope that grants visibility into another workspace.

## Deployment

Production runs behind a separate Caddy reverse proxy that terminates TLS.
Port 8080 must never be exposed directly to the Internet.

```bash
scripts/update.sh          # snapshot, pull, rebuild, restart, verify — one command
scripts/update.sh v1.2.3   # or deploy/roll back to a specific tag

# Both run inside the api container (needs its bundled better-sqlite3
# native module) — not bare on the host:
docker compose exec -T api node scripts/backup.mjs   # database + .env snapshot, on demand
docker compose exec -T api npm run migrate           # explicit migration run (also happens automatically on boot)
```

`scripts/update.sh` also tags the rebuilt images with the running
`package.json` version (`build-server-api:vX.Y.Z`,
`build-server-android:vX.Y.Z`) alongside `:latest` — a speed optimization
for a schema-compatible rollback (redeploy a cached image instead of
rebuilding); the git tag remains the source of truth either way.

See [docs/deployment.md](docs/deployment.md) for the full first-deploy,
update, backup, and restore walkthrough,
[docs/caddy-setup.md](docs/caddy-setup.md) for the reverse-proxy config
(both the API route and the web UI route), and
[PROJECT-SCOPE.md](PROJECT-SCOPE.md) for host firewall rules and
architecture.

## Web UI (optional)

`web/` is a plain static dashboard (no build step) — submit builds, watch
status, view logs and artifacts, cancel a running build. It's served by
its own `web` Compose service (`docker compose --profile web up -d`),
right here on the build-server host next to the API — a separate
public-facing Caddy just `reverse_proxy`s to it, the same way it does for
the API, rather than serving files itself. Needs `WEB_UI_ORIGIN` set in
`.env` for CORS, since its public hostname is a different origin than the
API's — and needs **real HTTPS on both hostnames**, not just for
security hygiene: the cross-origin session cookie is `SameSite=None`,
which every browser refuses to store without `Secure` (confirmed
directly against a real browser session). See
[docs/caddy-setup.md](docs/caddy-setup.md).

Sign-in is a real account — username, password, and a mandatory TOTP
second factor, kept as a session cookie — never a pasted API key.
Bootstrap the first admin with `scripts/create-user.mjs` (see Setup
above); every account after that is invited from the admin Users panel,
or self-requested via the sign-in page's "Request access" and approved
by an admin. Every account, including admins, is isolated from every
other account's builds/logs/artifacts/API keys — the one exception is an
admin's broadcast notification, shown to everyone as a dismissible
banner.

Signed in as an admin, the **Admin** page adds Users, Invites, Signup
requests, and Broadcast tabs alongside the existing Overview (version
vs. latest GitHub tag, a real `scripts/update.sh` trigger via a sibling
container over the same Docker socket the build workers use, a
`scripts/backup.mjs`-backed "Back up now" button, build metrics, and a
tail of the API's own operational log) — reachable only via a signed-in
admin session, never an API key, however permissive. The UI has its own
in-app **Help** page (reachable signed in or out) covering all of this
from a user's perspective; see
[docs/using-the-web-ui.md](docs/using-the-web-ui.md) for the full
walkthrough, [docs/caddy-setup.md](docs/caddy-setup.md) for the Caddy
config, or [docs/deployment.md](docs/deployment.md#web-ui-optional) for
`GITHUB_REPO`/`API_IMAGE` setup and the update-trigger's architecture.

## Status

v2.0.0: real user accounts (username/password + mandatory TOTP,
separate from API keys), absolute per-user workspace isolation with no
admin bypass, invite/request-access signup, and admin broadcast
notifications, on top of the v1.0.0 foundation — persistent build queue
with restart recovery, artifact metadata, build cancellation, retention
cleanup, structured logging, real health checks, Docker Compose
containerization, an automated test suite/CI, setup/update/backup
tooling, and an admin panel with a working update-trigger button. See
PROJECT-SCOPE.md's "Current Known Limitations" section for what's still
open (production alerting, a dedicated build-runner replacing
Docker-outside-of-Docker) before relying on this at real scale.

## Running tests

```bash
npm test
```

Tests hit a real, isolated SQLite database per test file and spawn real
(small, non-Android) Docker containers for the restart-recovery tests —
nothing is mocked. Requires Docker to be running locally.
