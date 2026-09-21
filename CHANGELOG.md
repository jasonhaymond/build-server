# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.4.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.4.0
[0.3.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.2.0
[0.1.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.1.0
