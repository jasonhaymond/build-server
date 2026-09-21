# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.10.0] - 2026-09-21

### Added

- Web UI (`web/`): a plain static dashboard (no build step, no framework —
  vanilla ES modules + `fetch()`) covering PROJECT-SCOPE.md's described
  feature set — build list with status, a submit-build form, and a build
  detail view (logs, artifacts with permanent download links, cancel). It
  never touches Gradle, Docker, SQLite, or build directories directly,
  only the same HTTP API any other client uses.
- `GET /api/v1/builds` (paginated, `build:read` scoped): needed for the
  dashboard's list view and not previously exposed — scoped to the
  caller's own builds unless it also holds `build:read:any`.
- CORS support (`WEB_UI_ORIGIN` env var): restricted to explicitly-known
  origins, never a wildcard, per the project's security baseline — needed
  since the web UI is served from its own Caddy site, a different origin
  than the API.
- `docs/deployment.md` and `README.md` updated with the web UI's setup
  (the Caddy site block, `WEB_UI_ORIGIN`) and its documented
  simplification: v1 sign-in is a manually-pasted API key in
  session storage, not real user accounts — PROJECT-SCOPE.md itself
  describes those as "Eventually" with no concrete design given.

### Fixed

- `sanitizeBuildForResponse` never included `projectName` in any API
  response, in any version of this project going back to the original
  prototype — every build status/list response showed only the raw build
  ID, never the human-readable project name that was already stored in
  the database. Found by actually looking at the dashboard in a real
  browser rather than only reading the response shape in code; a
  regression test now covers it.
- The header layout broke at mobile width (elements wrapped mid-word,
  overlapping the nav links) — found the same way, by screenshotting a
  375px viewport rather than assuming the flexbox layout would reflow
  correctly. Fixed with explicit wrap behavior in `web/style.css`.

Verified with a real headless-Chromium session (not just code review)
against a live API and a separately-served static site (genuinely
cross-origin, matching the production Caddy topology): sign-in, dashboard
listing, build submission end-to-end, build detail with real logs, and
cancellation UI — at both desktop (1280px) and mobile (375px) widths, with
zero browser console errors.

## [0.9.0] - 2026-09-21

### Added

- `scripts/setup.mjs`: interactive, idempotent `.env` setup — prompts for
  each value with a sensible default, generates
  `JOB_SECRETS_ENCRYPTION_KEY`, detects the host's Docker group GID, and
  asks before overwriting an existing `.env`. Never redisplays a
  previously-generated secret.
- `scripts/update.sh`: one-command deploy/update/rollback — refuses to run
  over uncommitted local changes, takes an unconditional pre-update
  snapshot (`scripts/backup.mjs`), rebuilds and restarts via Docker
  Compose, and polls `/health` before declaring success. Takes an optional
  version/tag argument; omitted, it updates to latest.
- `scripts/backup.mjs`: a consistent SQLite snapshot (`VACUUM INTO`) plus
  `.env`, packaged as `backups/build-server-vX.Y.Z-<timestamp>.tar.gz` —
  the manual-fallback backup tier the project standard allows for a
  smaller project. Named after the version actually recorded in the
  database, not `package.json` on disk.
- `app_meta` table (migration `0005`), upserted with the running version
  on every successful boot (not just deploys) — makes "which snapshot
  matches which version" answerable by reading the table, independent of
  whether a backup's filename survived intact.
- `docs/deployment.md` expanded with the setup/update/backup/restore
  walkthrough (both the scripted and manual path for each), and an
  honest restore-recoverability statement (what a restore recovers, how
  long it takes, what's lost since the last snapshot).

Verified end-to-end: `setup.mjs`'s overwrite guard, default-accepting,
key-generation-vs-preservation, and both the Compose and non-Compose
branches; `update.sh`'s uncommitted-changes and missing-`.env` guards in
an isolated scratch repo; a full real backup → data wipe → restore →
reboot cycle, confirming the API key and `app_meta` version both survived
and the restored server actually serves traffic.

Along the way, a genuine Node.js `readline/promises` quirk surfaced and
was worked around: `question()` can hang on the second call against
piped/non-TTY stdin on this Node version — `setup.mjs` uses the
callback-based `readline` API instead, which doesn't have the problem
and works identically for real interactive use.

## [0.8.0] - 2026-09-21

### Added

- Automated test suite (`vitest` + `supertest`, `npm test`), hitting a
  real per-test-file SQLite database and real Docker containers rather
  than mocking either — 38 tests across 7 files: authentication, scope
  enforcement, build submission validation, multi-tenant isolation, the
  full artifact lifecycle (register/list/download/revoke), restart
  recovery (reattach/interrupted/queued-with-secrets round-trip), ZIP
  symlink rejection, and Git source SSRF validation.
- `DB_PATH` env var override (`src/db/database.mjs`) so tests run against
  an isolated, disposable database instead of the real
  `data/build-server.db`.
- `src/api/server.mjs` now exports `app` and only calls
  `reconstructQueueOnStartup()`/`app.listen()` when run directly, so tests
  can exercise the real Express app via `supertest` without starting a
  real listener or touching the queue.
- `src/worker/zip.mjs`: `extractZipSafely` extracted out of the
  monolithic worker script so it's unit-testable directly, matching
  PROJECT-SCOPE.md's suggested `src/worker/` decomposition.
- GitHub Actions CI (`.github/workflows/ci.yml`): `npm ci && npm test` on
  every push/PR. `ubuntu-latest` ships Docker preinstalled, so the
  container-based recovery tests run there with no extra setup.

### Changed

- Clarified (in `src/security/scopes.mjs` and `README.md`) a multi-tenant
  behavior the isolation test surfaced while being written: an unscoped
  ("legacy full access") key can see any build, matching the behavior it
  had before multi-tenancy existed — isolation only applies between
  explicitly-scoped keys. Behavior was already correct; it just wasn't
  written down anywhere until a test forced the question.

## [0.7.0] - 2026-09-21

### Added

- Docker Compose containerization of the API (`Dockerfile.api`,
  `docker-compose.yml`). The container talks to the **host's** Docker
  daemon over a mounted `/var/run/docker.sock` (Docker-outside-of-Docker)
  so it can still launch isolated Android build containers — the
  privilege tradeoff this implies is documented plainly in
  `docs/deployment.md` rather than glossed over.
- `HOST_PROJECT_DIR` env var + `src/worker/docker.mjs`: the worker now
  resolves a build's Docker bind-mount source against the **host**
  filesystem path, not its own container-internal path — the daemon it
  talks to over the socket only understands host paths.
- `BUILD_CONTAINER_UID`/`BUILD_CONTAINER_GID` env vars replace deriving
  the Android build container's `--user` from the API process's own
  UID/GID, which stopped being meaningful once the API itself runs in a
  container (root, or a service account) rather than as a specific host user.
- The Android build image is renamed `build-server-android:latest`
  (was `android-build-server:latest`), matching the project's own rename —
  future platforms get their own `build-server-<platform>:latest` image.
- `docs/deployment.md`: first deploy and update walkthrough for the
  Compose-based setup, plus the DooD tradeoff write-up.

### Fixed

- `docker-compose.yml`'s port mapping assumed the container always
  listens on a fixed internal port; the app actually binds directly to
  `$PORT`, so a non-default `PORT` silently broke the mapping. Both sides
  of the mapping now use `${PORT:-8080}` consistently.

Verified: `Dockerfile.api` builds; the container's `docker` CLI reaches
the host daemon over the mounted socket (`docker version`); the full
Compose stack starts and `/health` reports real `ok` checks for both
SQLite and the Docker daemon from inside the container; a build submitted
through the containerized API runs the worker and reaches a real nested
`docker run` invocation with the correct container name, image, masked
env, and UID/GID. `resolveHostBuildDir`'s path construction was verified
directly inside a real Linux container against a proper POSIX host path
(the actual deployment target). A live nested-mount test on this Windows
dev machine hit a Windows-only artifact — a `C:/...` drive-letter path's
colon collides with Docker's `SRC:DST:MODE` `-v` syntax — which doesn't
apply to the real Linux target and isn't a code defect; noted here rather
than silently glossed over.

## [0.6.0] - 2026-09-21

### Added

- Structured JSON-line logging (`src/logging/logger.mjs`): the API process
  (`server.mjs`, `src/queue/queue.mjs`, `src/queue/recovery.mjs`) now logs
  `{ts, level, source, msg, ...}` to stdout and a rotating `logs/api.log`
  (simple size-based rotation, one backup), redacting any field whose key
  matches `secret`/`token`/`key`. The worker's own per-build `build.log`
  is unchanged — it serves a different purpose (build output for the
  caller, not API operations).
- `/health` now actually checks its dependencies instead of just
  confirming the process is up: a real SQLite query and a `docker info`
  call (3s timeout), returning `503`/`"degraded"` with a `checks` object
  naming which dependency failed if either is unreachable.
- `GET /api/v1/metrics` (new `metrics:read` scope): build counts by
  status, average build duration, and sample count. No alerting — just
  the hook, per the monitoring standard.
- Builds now record `duration_ms` (started → completed/failed/cancelled),
  computed at every completion path including restart-reattached builds.

Verified against a live server: health check reports real dependency
status, metrics correctly aggregate a real completed build's duration,
the `metrics:read` scope is enforced (403 without it), and logged secret-
like fields are redacted to `***` while other fields pass through.

## [0.5.0] - 2026-09-21

### Added

- Artifact metadata table (`artifacts`, migration `0004`): the worker now
  registers each artifact and its permanent download token at build time
  (`src/worker/artifacts.mjs`), replacing the old approach of scanning the
  artifacts directory and lazily creating a token on the first listing
  request. `GET /api/v1/builds/:id/artifacts` now reads this table.
- Artifact download token revocation:
  `DELETE /api/v1/builds/:id/artifacts/:filename/download-token`.
- API key scopes (`api_keys.scopes` column) and a `requireScope`/
  `requireBuildAccess` middleware layer covering PROJECT-SCOPE.md's listed
  scopes (`build:create`, `build:read`, `build:logs`, `build:cancel`,
  `artifact:download`, `artifact:manage`, `api-key:manage`), plus
  `build:read:any` for admin-style cross-tenant access. A key created with
  no `--scopes` gets full access — existing keys with no recorded scopes
  keep working unchanged.
- API key management over HTTP (`api-key:manage` scoped):
  `POST/GET /api/v1/api-keys`, `DELETE /api/v1/api-keys/:id`. The CLI
  script (`scripts/create-api-key.mjs`) now also accepts `--scopes`.
- Build cancellation: `POST /api/v1/builds/:id/cancel` — removes a still-
  queued build from the queue directly, or `docker kill`s a running
  build's container by its deterministic name and reports it `cancelled`
  rather than `failed`.
- Multi-tenant build isolation: every build now records the submitting
  `api_key_id`; a key can only read/cancel/download artifacts for its own
  builds unless it holds `build:read:any`. Mismatches return 404, not 403,
  to avoid confirming a build ID exists. Builds with no recorded owner
  (pre-existing data) remain accessible to any key with the right scope.
- Retention/cleanup (`scripts/cleanup.mjs`, `RETENTION_DAYS`): deletes the
  on-disk `builds/<id>` directory for old completed/failed/cancelled
  builds and disables their artifact records and download tokens. The
  `builds` table row itself is kept for history.

Verified end-to-end against a live server: multi-tenant isolation (a
second client gets 404 on another client's build; an admin-scoped key
still sees it), scope enforcement (403 on missing scopes), the full
artifact lifecycle (register → list → public download → revoke → 404,
with the authenticated filesystem-based download unaffected by
revocation), API key management over HTTP, and retention cleanup
correctly disabling a backdated build's artifacts.

## [0.4.0] - 2026-09-21

### Added

- Persistent build queue and restart recovery — PROJECT-SCOPE.md's own
  stated "Immediate Next Task." The API now persists each build's full job
  (env plaintext, secrets encrypted at rest with a new
  `JOB_SECRETS_ENCRYPTION_KEY`, AES-256-GCM) to SQLite at submission time,
  and reconstructs the in-memory queue from the database on startup
  (`src/queue/recovery.mjs`):
  - Builds still `queued` when the API last stopped are decrypted and
    re-enqueued in original submission order.
  - Builds that were `building` are checked against the Docker daemon by
    their deterministic container name
    (`build-<platform>-<buildId>`, added in 0.3.0). If the container is
    still running, the API reattaches to it (`docker logs -f` / `docker
    wait`) instead of requeuing a duplicate build. If it's gone, the build
    is marked `failed` with `failure_reason: "Interrupted by server
    restart"`.
  - The encrypted job payload is overwritten with the existing `***`-masked
    form as soon as a build actually starts — it only needs to exist while
    a build is genuinely queued.
  - The API now refuses to start if `JOB_SECRETS_ENCRYPTION_KEY` is missing
    or malformed, rather than failing on the first submission.
- New `builds` columns (migration `0003_queue_recovery`) for the queue
  payload and the metadata PROJECT-SCOPE.md's Database section calls out
  as future fields: `platform`, `variant`, `artifact_type`, `duration_ms`,
  `worker`, `failure_reason`, `cancellation_state`, `submitted_by`,
  `api_key_id`.

Verified against real dependencies (no mocks): a `building` row with a
live matching container reattaches and completes correctly; one with no
matching container is marked failed as interrupted; a `queued` row's
encrypted job (including a real secret) round-trips through decryption and
runs through the actual worker process, and the raw database file never
contains the plaintext secret at any point. Also verified end-to-end
through the live HTTP API (submit → building → failed, with the persisted
`job_payload` masked once the build started).

## [0.3.0] - 2026-09-21

### Added

- ZIP symlink protection: `src/worker/index.mjs`'s ZIP extraction now uses
  `yauzl` to inspect every entry's Unix mode before writing it, rejecting
  symlink entries in addition to the existing absolute-path/`..`-traversal
  checks. Extraction is now done fully in Node rather than shelling out to
  `unzip`. This was the prerequisite PROJECT-SCOPE.md called out before
  arbitrary public ZIP uploads could be considered.
- Git source SSRF protection (`src/security/gitSource.mjs`): Git sources
  must be HTTPS and must not resolve to a private/link-local/loopback
  address, closing off the internal-network-probing path PROJECT-SCOPE.md
  flagged. Trusted/internal use (including local filesystem paths, like the
  proven Clocker build) can opt back in via `ALLOW_LOCAL_GIT_SOURCES=true`.
- Build timeout: `BUILD_TIMEOUT_MS` (default 2 hours) now bounds every
  build; a build that exceeds it is killed via `docker kill` and marked
  failed with a clear timeout reason, instead of blocking the (currently
  single-concurrency) queue indefinitely.
- Deterministic per-build container names (`build-<platform>-<jobId>`),
  needed for the timeout to reliably kill the right container and for the
  upcoming persistent-queue recovery work to find a still-running build's
  container after a restart.

## [0.2.0] - 2026-09-21

### Changed

- Renamed the project from `android-build-server` to `build-server`. The
  server is meant to grow beyond Android over time; the name shouldn't need
  to change again when that happens. `package.json`'s `name` is now
  `build-server`. Platform-specific naming (build images, container names)
  is addressed as those areas are touched, rather than all at once.
- Replaced the inline `CREATE TABLE IF NOT EXISTS` schema setup in
  `src/db/database.mjs` with a minimal forward-only migration runner
  (`src/db/migrate.mjs` + `src/db/migrations/`), tracked in a new
  `schema_migrations` table. Today's schema (including the 0.1.0
  `artifact_download_tokens` fix) is captured as the honest starting point
  in `0001_init` / `0002_artifact_tokens`. Future schema changes ship as
  new numbered migration files instead of hand-edited `CREATE TABLE`
  statements — matches the project's non-interactive, forward-only
  migration standard.

## [0.1.0] - 2026-09-21

### Fixed

- `artifact_download_tokens` table was queried and written to by the API but
  was never created by `src/db/database.mjs`'s schema setup. It only existed
  on the running server because it had been created out-of-band directly
  against the live database. A fresh clone or fresh deploy would have crashed
  on the first artifact-listing request. Added the missing `CREATE TABLE IF
  NOT EXISTS` statement so the schema is fully reproducible from source.

### Added

- Initial import of the working prototype into a proper repository: Express
  API (`src/api/server.mjs`), SQLite persistence layer
  (`src/db/database.mjs`), isolated Docker build worker
  (`src/worker/index.mjs`), and API key provisioning script
  (`scripts/create-api-key.mjs`).
- Proven functionality carried over from the prototype: directory/ZIP/Git
  source ingestion, monorepo `projectRoot` support, arbitrary build
  env vars, separate build secrets with log/response masking, isolated
  Docker builds with CPU/memory/PID limits, bearer API-key auth, permanent
  unguessable artifact download tokens, and a real Clocker release build
  completed end-to-end through the generic worker.

[0.10.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.10.0
[0.9.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.9.0
[0.8.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.8.0
[0.7.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.7.0
[0.6.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.6.0
[0.5.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.5.0
[0.4.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.4.0
[0.3.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.2.0
[0.1.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.1.0
