# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/jasonhaymond/android-build-server/releases/tag/v0.1.0
