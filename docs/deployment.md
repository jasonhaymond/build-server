# Deployment

This covers running `build-server` under Docker Compose, which is the
supported way to run the API in production. It does not yet cover an
interactive setup script, an update script, or backups — those are planned
(see PROJECT-SCOPE.md's roadmap) but not built yet. This document will be
expanded when they land; until then, first-time setup is manual, as below.

## Architecture recap

```text
Caddy (separate host, terminates TLS)
   |
   v
API container (this repo, Docker Compose)
   |
   v
Isolated Android build container (per build, launched by the API container)
```

## The Docker-outside-of-Docker tradeoff

The API container needs to launch separate, isolated Android build
containers for each submitted build. To do that, it talks to the **host's**
Docker daemon over a bind-mounted `/var/run/docker.sock`
(`docker-compose.yml`), rather than running its own nested Docker daemon.

This means: **the API container effectively has the same Docker control as
the host user running it** — it can start, stop, or inspect any container
on that host, not just the build containers it creates itself. This is a
real privilege boundary, stated plainly rather than glossed over.

It's an accepted tradeoff for now, not an oversight:

- Submitted build source never runs inside the API container — only
  inside the separately-launched, resource-limited (`--cpus`, `--memory`,
  `--pids-limit`), non-root Android build container. The socket access
  belongs to the API/worker code, which is trusted, not to untrusted
  submitted source.
- A compromise of the API process itself (e.g. a bug in a future feature)
  would be a serious issue regardless of the socket — DooD makes the
  ceiling on "how serious" higher than it would be without it.
- The stronger alternative — a dedicated, more isolated build-runner
  service instead of DooD — is tracked as a known follow-up (PROJECT-SCOPE.md
  calls this "Option B"), not implemented yet.

Don't run this on a host where other sensitive containers you don't want
the build server touching are also running, until that hardening lands.

## Prerequisites

- Docker and Docker Compose installed on the target host.
- Port 8080 (or whatever `PORT` you choose) free on that host, or already
  known to belong to this deployment if you're updating an existing one.
  A **new** deployment to a host should check for a conflicting listener
  first (`ss -ltnp | grep :8080` or equivalent) rather than assume it's free.
- A separate reverse proxy (Caddy is the default choice for this project)
  terminating TLS and forwarding to this host's `PORT`. See
  PROJECT-SCOPE.md's Reverse Proxy section for the Caddy config shape.
  Setting up the reverse proxy is a manual step — it's system-level config
  this repo doesn't own.
- Host firewall (`ufw` or equivalent) allowing only SSH, 80, and 443
  externally, plus the reverse-proxy host's IP on `PORT` internally. Never
  expose `PORT` to the Internet directly.

## First deploy

```bash
git clone <this-repo-url> build-server
cd build-server

cp .env.example .env
```

Edit `.env`:

- `PORT` — pick one that's free on this host (see Prerequisites).
- `PUBLIC_BASE_URL` — the public HTTPS URL the reverse proxy will expose
  this service at (e.g. `https://builds.example.com`).
- `JOB_SECRETS_ENCRYPTION_KEY` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  The API refuses to start without a validly-formatted key.
- `HOST_PROJECT_DIR` — the **absolute host path** to this cloned directory
  (e.g. `/home/deploy/build-server`). Required because the API container's
  own internal path (`/app/...`) means nothing to the host Docker daemon it
  talks to over the mounted socket — see the DooD section above.
- `DOCKER_GID` — the host's docker group id, so the API container's user
  can access the mounted socket without running as root:
  ```bash
  getent group docker | cut -d: -f3
  ```
- `BUILD_CONTAINER_UID` / `BUILD_CONTAINER_GID` — leave at the defaults
  (`1000:1000`) unless you have a specific reason to change them.
- `ALLOW_LOCAL_GIT_SOURCES` — leave `false` unless this deployment is
  trusted/internal-only.

Build the Android build image (the isolated per-build environment, not the
API itself) and bring up the API:

```bash
docker build -t build-server-android:latest .
docker compose up -d --build
```

Verify it's actually serving traffic:

```bash
curl http://localhost:${PORT:-8080}/health
```

Create your first API key:

```bash
docker compose exec api node scripts/create-api-key.mjs "my-first-client"
```

Save the printed key now — it's shown once and isn't recoverable; only its
hash is stored. Then configure the reverse proxy (manual, system-level
step) to forward `PUBLIC_BASE_URL`'s hostname to `10.x.x.x:PORT` on this
host, per PROJECT-SCOPE.md's Caddy example.

## Updating

There's no dedicated update script yet. Until one exists:

```bash
cd build-server
git status              # make sure there's nothing uncommitted to lose
git pull                # or: git checkout vX.Y.Z for a specific version
docker build -t build-server-android:latest .   # if the build image changed
docker compose up -d --build
curl http://localhost:${PORT:-8080}/health
```

SQLite migrations run automatically on API startup
(`src/db/migrate.mjs`) — forward-only, no manual step needed.

## Rolling back

Docker Compose containerization has no down-migrations (per this project's
migration standard). Rolling back code (`git checkout vX.Y.Z` followed by
the update steps above) is always safe. Rolling back the **database** to
match an older code version is not — if a migration since that version
dropped, renamed, or tightened a constraint on existing data, old code will
break against the current schema, and there is currently no automated
snapshot/restore tooling to fall back on. This is a known gap; backups and
version-stamped snapshots are planned but not built yet (see
PROJECT-SCOPE.md's roadmap and the global Backups standard this project
otherwise follows).
