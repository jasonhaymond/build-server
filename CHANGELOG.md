# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.2.0
[0.1.0]: https://github.com/jasonhaymond/build-server/releases/tag/v0.1.0
