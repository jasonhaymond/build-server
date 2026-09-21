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
  `scripts/setup.mjs` checks this automatically for a **new** port choice
  (it doesn't re-check a port this same deployment already owns from a
  prior run) and offers to pick a different one; the manual equivalent is
  `ss -ltnp | grep :8080` or similar before assuming it's free.
- A separate reverse proxy (Caddy is the default choice for this project)
  terminating TLS and forwarding to this host's `PORT`. This is a manual,
  system-level step this repo doesn't own — see
  **[caddy-setup.md](caddy-setup.md)** for the full setup (both this API
  route and the web UI route, if you're running that too), including a
  complete example Caddyfile, DNS/firewall prerequisites, and Caddy-side
  troubleshooting. In short: `PUBLIC_BASE_URL` in `.env` must match
  whatever public hostname you point Caddy at, exactly — not this host's
  LAN address.
- Host firewall (`ufw` or equivalent) allowing only SSH, 80, and 443
  externally, plus **specifically the reverse-proxy host's IP** on `PORT`
  internally — not the whole LAN. Example:
  ```bash
  sudo ufw allow from 10.x.x.x to any port 8080 proto tcp
  ```
  Never expose `PORT` to the Internet directly, and never allow it from
  "anywhere" on the LAN either — only from the specific host running Caddy.

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
  this service at (e.g. `https://builds-api.example.com`).
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
- `GITHUB_REPO` (optional) — `owner/repo`, used by the web UI's Admin page
  to check for a newer version. Leave unset to skip the check.

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
hash is stored. Then set up the reverse proxy — see
**[caddy-setup.md](caddy-setup.md)**.

## Updating

```bash
scripts/update.sh              # update to the latest commit on this branch
scripts/update.sh v1.2.3       # or deploy/roll back to a specific tag
```

The script refuses to run over uncommitted local changes, takes a database
+ `.env` snapshot first (`scripts/backup.mjs`) regardless of any other
backup schedule, rebuilds the Android image, restarts the API via Compose,
and polls `/health` before declaring success. It also tags both rebuilt
images with the running `package.json` version
(`build-server-android:vX.Y.Z`, `build-server-api:vX.Y.Z`) alongside
`:latest` — lets a schema-compatible rollback redeploy a cached image
instead of rebuilding from source. The git tag is still the source of
truth; image caches get pruned, a git tag doesn't.

Can also be triggered from the web UI's Admin page (a `system:manage`
key) instead of an SSH session — see Web UI below for how that works and
its architecture.

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

## Web UI (optional)

This section is about *deploying* the web UI. For what it's like to
actually use — the dashboard, submitting a build, the Admin page — see
[using-the-web-ui.md](using-the-web-ui.md), or the UI's own in-app Help
page, which covers the same ground and is reachable with or without
being signed in.

`web/` is a plain static site (no build step, no framework) that talks to
this API over plain HTTP `fetch()` — it never touches Gradle, Docker,
SQLite, or build directories directly, only the same API any other client
uses. It's meant to be served by Caddy as its **own** site, not by the API
process.

Because it's a different origin from the API, the API needs to be told to
allow it via CORS — set `WEB_UI_ORIGIN` in `.env` to the exact origin the
web UI is served from (e.g. `https://builds.example.com` — the primary
domain; the API gets the `builds-api.<domain>` subdomain), then
`docker compose up -d` (or restart the non-Compose process) to pick it
up. Leaving it unset means no cross-origin access at all — never set it
to a wildcard.

Adding the Caddy site block is a manual, system-level step (this repo
doesn't own Caddy's config) — see **[caddy-setup.md](caddy-setup.md)**
for the full setup: a complete example Caddyfile for both this route and
the API's, getting `web/` onto the Caddy host, a cache-control detail
specific to this app's no-build-step static files, and optional
IP-restriction if the dashboard shouldn't be fully public.

Sign-in is a manually-pasted API key (created with
`scripts/create-api-key.mjs`), kept only in that browser tab's session
storage — cleared on sign-out or tab close, never sent anywhere but this
API. This is a deliberate, documented simplification for now, not real
user accounts/sessions — PROJECT-SCOPE.md itself describes those as
"Eventually," with no concrete design given (no user table, no password
policy). A key with `build:read:any` sees every client's builds in the
dashboard, matching its API-level access; a scoped key only sees its own.

### Admin page (version, update trigger, backups, logs)

A key with the `system:manage` scope sees an **Admin** page: current
version vs. the latest GitHub tag (`GITHUB_REPO`), a build-metrics
summary, a tail of the API's own operational log
(`GET /api/v1/system/logs`), a **Back up now** button
(`POST /api/v1/system/backup`, runs the same `runBackup()` logic as
`scripts/backup.mjs` — one implementation, two callers), and an
**Update now** button. This is the in-app equivalent of running
`scripts/update.sh`/`scripts/backup.mjs` over SSH, per the project's
built-in-update-visibility and backups standards — same scripts, same
safety guards, just triggered from a browser instead of a terminal. The
update button shows a confirmation dialog before firing, since it
redeploys the live service; the backup button doesn't need one (it's not
destructive).

Signing in only requires a *valid* key (`GET /api/v1/whoami`, no
particular scope) — an admin-only key with `system:manage` but not
`build:read` can still sign in and use the Admin page; it just can't load
the build dashboard, and shows a clear scope error there instead of being
silently locked out of signing in at all.

**How it actually works** — the API container only has its own source
baked into its image at build time, not the live git repo or
`docker-compose.yml` as a directory tree, so it can't run `git pull` /
`docker compose up` on *itself*. Clicking the button
(`POST /api/v1/system/update`, `src/system/update.mjs`) instead spawns a
short-lived **sibling** container — the same image (`API_IMAGE`, set in
`docker-compose.yml`), launched over the same Docker socket the API
already uses for build containers — with the full host project directory
bind-mounted at its real host path (`HOST_PROJECT_DIR`, the same variable
and pattern the build-container mounts already use) and `--network host`
so the script's own health-check `curl` can reach the restarted service's
published port. That sibling container runs the real
`scripts/update.sh`, unmodified, with every one of its safety guards
intact.

Requires `HOST_PROJECT_DIR` and `API_IMAGE` to be set (Compose deployments
only); without them the button returns a clear error rather than doing
nothing silently. `Dockerfile.api` includes the `docker compose` CLI
plugin and `curl` specifically so this sibling container can run the
update script end to end.

This mechanism was verified end-to-end on a real Linux container (the
actual deployment target): a sibling container using this exact
mount/socket/network pattern successfully brought up a Compose stack and
reached its published port via `--network host`. The button itself
(spawning that sibling container from a live API process) was verified up
to the point of "does the API correctly refuse when misconfigured, and
does it correctly construct and send the request" — actually letting it
redeploy a real running deployment as part of a test has no place in an
automated suite, for the same reason `scripts/update.sh` itself isn't
run for real in CI.

The backup button was verified further, including through a real browser
session: sign-in with an admin-only key, click, request reaches the API,
`runBackup()` executes for real. (One `tar` quirk surfaced only on
Windows dev machines — a `C:\...` path's drive-letter colon collides with
bsdtar's `host:path` syntax — and doesn't apply to the real Linux target,
where the identical code was independently verified working via
`scripts/backup.mjs`.)

That same test against a real Compose deployment caught a genuine gap:
`.env` wasn't bind-mounted into the API container at all, so a backup
triggered from the web UI silently omitted it (`envIncluded: false` in
the response) even though the CLI script, run on the host, always
included it. Fixed by mounting `./.env:/app/.env:ro` in
`docker-compose.yml` — read-only, since `env_file:` already injects its
values as environment variables; the file itself only needs to be
*readable* for `runBackup()` to copy it into the archive.

## Troubleshooting

**API container exits immediately with `JOB_SECRETS_ENCRYPTION_KEY is not
set` or `...must be a 32-byte key`** — `.env` is missing the key or it's
malformed. Generate one and re-run: `node -e
"console.log(require('crypto').randomBytes(32).toString('hex'))"`. This
check runs before anything else, deliberately — better to fail loudly at
startup than on the first build submission.

**`docker compose up` succeeds but `/health` shows
`"docker": "error: ..."`** — usually `DOCKER_GID` is wrong or unset, so
the container's user can't read/write the mounted `/var/run/docker.sock`.
Confirm with `getent group docker | cut -d: -f3` on the host, put that
exact number in `.env`, and `docker compose up -d` again (a plain restart
isn't enough — `group_add` is applied at container creation).

**A build fails instantly with `Source path not found: ...`** — for a
`directory`-type source, the path is resolved *inside the API/worker
container's own filesystem*, not the host's. If you're testing with a
local project, it needs to be under a directory this container already
has mounted (e.g. copy it under `uploads/` on the host, which is
bind-mounted into the container).

**A build fails with `Git source rejected: ...`** — SSRF protection
(`src/security/gitSource.mjs`) rejects non-HTTPS URLs and anything
resolving to a private/loopback/link-local address by default. For a
trusted/internal Git server or a local path, set
`ALLOW_LOCAL_GIT_SOURCES=true` — only on deployments you actually trust
with that, since it also allows local filesystem paths as sources.

**The web UI can't sign in / dashboard shows a CORS error in the browser
console** — `WEB_UI_ORIGIN` in `.env` must exactly match the origin the
web UI is actually served from (scheme + host, e.g.
`https://builds.example.com`, no trailing slash), and the API must be
restarted after changing it. If it's unset, no cross-origin request is
allowed at all — intentional, not a bug.

**The Admin page's "Update now" button returns `HOST_PROJECT_DIR and
API_IMAGE must be set`** — this only works for Docker Compose deployments
where both are actually configured. `API_IMAGE` is set directly in
`docker-compose.yml` (not `.env`) and should already be there; if you
changed the compose file, make sure it's still set. `HOST_PROJECT_DIR`
must be the deployment directory's real, absolute path *as the host
sees it* — check it against `pwd` on the host, not a path copied from
somewhere else.

**`scripts/update.sh` (or the Admin page's update button) doesn't seem to
do anything, or the sibling container exits immediately** — check
`docker ps -a --filter name=build-server-update-` for its exit code and
`docker logs <name>` for output (it uses `--rm`, so this only works in
the few seconds before it cleans itself up — re-trigger and check
quickly, or temporarily drop `--rm` from `src/system/update.mjs` while
debugging). Common cause: uncommitted changes on the host blocking
`scripts/update.sh`'s own guard — check `git status` there.

**`node scripts/backup.mjs` (or the Admin page's backup button) fails with
`tar: ...`** — if you're testing this on Windows, bsdtar interprets a
`C:\...` path's drive-letter colon as a remote-host spec
(`tar (child): Cannot connect to C: resolve failed`). This doesn't happen
on the real Linux deployment target; it's a Windows-dev-machine-only
artifact, documented in `CHANGELOG.md`.

**A build never leaves `queued`** — only one build runs at a time by
design (`PROJECT-SCOPE.md`'s "Build concurrency is currently effectively
one build"). Check `GET /api/v1/system` (or the Admin page) for
`activeBuild`/`queuedBuilds` — if a build's been `building` far longer
than expected, its container may be stuck; `POST
/api/v1/builds/:id/cancel` on it to free the queue.

**After a restart, a build that was `building` shows `failed` with
`"Interrupted by server restart"`** — this is `src/queue/recovery.mjs`
working as designed, not a bug: it only reattaches to a build whose
Docker container is still actually running (found by its deterministic
name, `build-<platform>-<buildId>`). If the container is gone too (e.g.
the whole host rebooted, not just the API), there's nothing left to
reattach to, so it's correctly marked failed rather than silently lost.
