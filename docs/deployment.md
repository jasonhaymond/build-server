# Deployment

This covers running `build-server` under Docker Compose, which is the
supported way to run the API in production. It gives both the interactive
setup script's version of each step and the exact manual commands behind
it — a reader following the manual path ends up in the same place as
someone who ran the script.

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
node scripts/setup.mjs
```

The setup script is interactive and idempotent — it prompts for each value
below with a sensible default, generates `JOB_SECRETS_ENCRYPTION_KEY` for
you, detects `DOCKER_GID` automatically where possible, and asks before
overwriting an existing `.env`. Save the generated key somewhere real when
it tells you to — it's shown only once and can't be recovered later, only
rotated (which loses any build still genuinely queued at rotation time).

**Manual equivalent**, if you'd rather not run the script:

```bash
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

**Both paths continue the same way** — build the Android build image (the
isolated per-build environment, not the API itself) and bring up the API:

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

```bash
scripts/update.sh              # update to the latest commit on this branch
scripts/update.sh v1.2.3       # or deploy/roll back to a specific tag
```

The script refuses to run over uncommitted local changes, takes a database
+ `.env` snapshot first (`scripts/backup.mjs`) regardless of any other
backup schedule, rebuilds the Android image, restarts the API via Compose,
and polls `/health` before declaring success.

**Manual equivalent:**

```bash
cd build-server
git status                                      # nothing uncommitted to lose
node scripts/backup.mjs                         # snapshot first, always
git pull                                        # or: git checkout vX.Y.Z
docker build -t build-server-android:latest .
docker compose build
docker compose up -d
curl http://localhost:${PORT:-8080}/health
```

SQLite migrations run automatically on API startup
(`src/db/migrate.mjs`) — forward-only, no manual step needed.

## Rolling back

Docker Compose containerization has no down-migrations (per this project's
migration standard). Rolling back **code** (`scripts/update.sh vX.Y.Z`) is
always safe and fully reproducible. Rolling back the **database** to match
an older code version is not — if a migration since that version dropped,
renamed, or tightened a constraint on existing data, old code will break
against the current schema, and the only real fix is restoring the
database snapshot taken around that older version's original deploy (see
Backups below). That restore **discards any data created since**, which is
a real trade-off, not a formality. If nothing schema-relevant changed
between the two versions, old code runs fine against the current database
and there's nothing more to do.

`scripts/update.sh` always takes the unconditional pre-update snapshot;
whether you also need the database-rollback step is something you decide
after checking what changed, not something the script guesses for you.

## Backups

```bash
node scripts/backup.mjs
```

This is the manual-fallback tier the project's backup standard allows for
a smaller project (a full encrypted/deduplicated setup like BorgBackup is
the eventual target for anything with a retention policy, not built yet).
It:

- Takes a consistent SQLite snapshot (`VACUUM INTO`, safe against a live
  database) plus a copy of `.env` — the database alone isn't enough to
  recover, since `.env` holds secrets that aren't in git.
- Names the archive after the version actually recorded in the database's
  `app_meta` table (upserted on every successful boot, not just deploys),
  not `package.json` on disk — `backups/build-server-vX.Y.Z-<timestamp>.tar.gz`.
- Is also run automatically, unconditionally, by `scripts/update.sh`
  before every update — independent of whatever scheduled backup you set
  up separately (e.g. a cron job calling `node scripts/backup.mjs`).

**This only protects you if the backups leave the host.** Copy the
`backups/` directory off-host (a separate backup server over SSH, object
storage, etc.) — a backup on the same disk as the database doesn't survive
that disk failing.

### Restoring

```bash
tar -xzf backups/build-server-vX.Y.Z-<timestamp>.tar.gz -C /tmp/restore
docker compose down            # or: stop the non-Compose process
cp /tmp/restore/build-server.db data/build-server.db
cp /tmp/restore/.env .env
docker compose up -d
curl http://localhost:${PORT:-8080}/health
```

After restoring, confirm which version actually came back by reading
`app_meta` directly rather than trusting the archive's filename (which
survives fine here, but wouldn't if renamed):

```bash
docker compose exec api node -e "
const { getAppMeta } = require('./src/db/database.mjs');
console.log(getAppMeta());
"
```

This restore path has been exercised end-to-end (real backup → wipe →
restore → boot → verified API key and `app_meta` survived), not just
assumed to work.

**Recoverability**: a restore brings back the database exactly as of the
snapshot and takes under a minute for a database this size. Data created
between that snapshot and the failure is lost — the RPO is however often
you actually run `scripts/backup.mjs` on a schedule (cron) plus whatever
`scripts/update.sh` captured on the last update. There's no scheduled
backup wired up by default yet; add one (e.g. a nightly cron calling
`node scripts/backup.mjs`, followed by copying `backups/` off-host) if
this deployment holds anything you can't afford to lose since the last
manual run.
