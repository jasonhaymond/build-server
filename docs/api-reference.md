# API reference

This is the current, authoritative endpoint reference — generated against
`src/api/server.mjs` directly, not hand-maintained separately from the
code. `PROJECT-SCOPE.md` also has an API section, but it's the original
handoff spec and predates scopes, `whoami`, the build list, and everything
under `/api/v1/system` — treat this document as the current source and
`PROJECT-SCOPE.md` as historical background on the source/build schema
and security model.

Base URL in production: `https://<your-public-hostname>/api/v1` (plus the
unversioned `/health` and `/download/:token/:filename`).

## Authentication

Every `/api/v1/*` route requires:

```http
Authorization: Bearer <API_KEY>
```

Keys are created with `scripts/create-api-key.mjs` or
`POST /api/v1/api-keys`, begin with `abs_`, and are shown once — the
server stores only a SHA-256 hash. A key created with no scopes has full
access to everything (preserves behavior for keys created before scopes
existed); a scoped key only has what it was explicitly granted.

`GET /health` and `GET /download/:token/:filename` need no API key —
`/health` is meant for external uptime monitors, and the download URL
itself is the bearer credential (see Permanent download tokens below).

### Scopes

| Scope | Grants |
|---|---|
| `build:create` | `POST /api/v1/builds` |
| `build:read` | `GET /api/v1/builds`, `GET /api/v1/builds/:id` (own builds only — see Multi-tenancy) |
| `build:read:any` | Ownership bypass for **every** build-scoped route (read, logs, artifacts, cancel) — combine with the specific action scope needed, e.g. `["build:read", "build:read:any"]` |
| `build:logs` | `GET /api/v1/builds/:id/logs` |
| `build:cancel` | `POST /api/v1/builds/:id/cancel` |
| `artifact:download` | `GET /api/v1/builds/:id/artifacts`, `GET /api/v1/builds/:id/artifacts/:filename` |
| `artifact:manage` | `DELETE /api/v1/builds/:id/artifacts/:filename/download-token` |
| `api-key:manage` | `POST/GET /api/v1/api-keys`, `DELETE /api/v1/api-keys/:id` |
| `metrics:read` | `GET /api/v1/metrics` |
| `system:manage` | `GET /api/v1/system`, `GET /api/v1/system/logs`, `POST /api/v1/system/backup`, `POST /api/v1/system/update` |

`GET /api/v1/whoami` requires a valid key but no particular scope — it's
what the web UI uses to verify sign-in without assuming any scope, so an
admin-only key (`system:manage` but not `build:read`) isn't locked out of
signing in.

### Multi-tenancy

Every build records the API key that submitted it. A key can only
read/watch-logs-for/download-artifacts-from/cancel builds it submitted
itself, unless it also holds `build:read:any`. A build with no recorded
owner (predates multi-tenant tracking) is accessible to any key with the
right scope. Mismatches return **404, not 403** — a key with the right
scope but wrong ownership can't tell a build ID exists at all.

## Health

### `GET /health`

No auth. Actually checks dependencies (a real SQLite query, `docker
info`), not just "the process is up."

```json
{
  "status": "ok",
  "service": "build-server",
  "activeBuild": false,
  "queuedBuilds": 0,
  "checks": { "database": "ok", "docker": "ok" }
}
```

Returns `503` with `"status": "degraded"` and the failing check's error
message under `checks` if either dependency is unreachable.

## Identity

### `GET /api/v1/whoami`

Any valid key.

```json
{ "id": 3, "name": "ci-bot", "scopes": ["build:create", "build:read"] }
```

`scopes` is `null` for a full-access key.

## Builds

### `POST /api/v1/builds`

Scope: `build:create`.

```json
{
  "project": {
    "name": "Example",
    "source": { "type": "git", "url": "https://github.com/example/project.git", "ref": "main" },
    "projectRoot": "app"
  },
  "build": {
    "platform": "android",
    "variant": "release",
    "artifact": "apk",
    "env": { "EXPO_PUBLIC_API_URL": "https://example.com" },
    "secrets": { "ANDROID_GOOGLE_MAPS_API_KEY": "..." }
  }
}
```

- `project.source.type`: `"git"`, `"upload"`, or `"directory"` (directory
  is for trusted/internal use only — see PROJECT-SCOPE.md). Git sources
  must be HTTPS and resolve to a public address unless
  `ALLOW_LOCAL_GIT_SOURCES=true`.
- `project.projectRoot` (optional): relative path to the Android project
  within the submitted source, for monorepos.
- `build.variant`: `"debug"` or `"release"`. `build.artifact`: `"apk"` or
  `"aab"`.
- `build.env` / `build.secrets`: plain objects, string/number/boolean
  values only, keys matching `^[A-Za-z_][A-Za-z0-9_]*$`. Secrets are
  encrypted at rest while queued and masked (`***`) everywhere else —
  logs, persisted job records, API responses — the instant the build
  starts.

Returns `202`:

```json
{ "id": "bld_mabc123_a1b2c3d4", "status": "queued" }
```

`400` if `project.name` is missing or the body isn't a JSON object. Deeper
validation (source reachability, env/secret shape) happens in the worker
once the build starts — check `GET .../logs` for those failures.

### `GET /api/v1/builds`

Scope: `build:read`. Query params: `limit` (default 50, max 200),
`offset` (default 0). Scoped to the caller's own builds unless it also
holds `build:read:any`.

```json
{
  "builds": [
    {
      "id": "bld_mabc123_a1b2c3d4",
      "projectName": "Example",
      "status": "completed",
      "submittedAt": "2026-09-21T18:00:00.000Z",
      "startedAt": "2026-09-21T18:00:01.000Z",
      "completedAt": "2026-09-21T18:04:12.000Z",
      "exitCode": 0,
      "error": null,
      "platform": "android",
      "variant": "release",
      "artifactType": "apk",
      "failureReason": null,
      "cancellationState": null
    }
  ],
  "limit": 50,
  "offset": 0
}
```

### `GET /api/v1/builds/:id`

Scope: `build:read`. Returns one build in the same shape as an entry
above. `404` if it doesn't exist or belongs to a different key.

### `GET /api/v1/builds/:id/logs`

Scope: `build:logs`. Returns the build's raw log as `text/plain` (empty
string, as JSON `{"id": ..., "logs": ""}`, if the build hasn't started
writing one yet).

### `POST /api/v1/builds/:id/cancel`

Scope: `build:cancel`.

- A still-queued build is removed from the queue directly.
- A `building` build gets `docker kill`ed by its deterministic container
  name and reported `cancelled`, not `failed`.
- `409` if the build is already in a terminal state
  (`completed`/`failed`/`cancelled`).

```json
{ "id": "bld_mabc123_a1b2c3d4", "status": "cancelling" }
```

(`"cancelled"` immediately if it was only queued; `"cancelling"` if a
`docker kill` was just issued for a running build — poll `GET .../:id`
for the final status.)

## Artifacts

### `GET /api/v1/builds/:id/artifacts`

Scope: `artifact:download`.

```json
{
  "id": "bld_mabc123_a1b2c3d4",
  "artifacts": [
    {
      "filename": "Example-release.apk",
      "size": 95600000,
      "downloadUrl": "https://builds-api.example.com/download/<token>/Example-release.apk"
    }
  ]
}
```

`downloadUrl` is permanent, unauthenticated, and unguessable (see below)
— it's registered by the worker at build time, not generated on demand.

### `GET /api/v1/builds/:id/artifacts/:filename`

Scope: `artifact:download`. Streams the file directly (authenticated
alternative to the public download URL — useful if you don't want to
depend on the permanent-URL mechanism, or need the file without keeping
the token around).

### `DELETE /api/v1/builds/:id/artifacts/:filename/download-token`

Scope: `artifact:manage`. Disables that artifact's permanent download
token — the public URL starts 404ing immediately. One-way; there's no
"reissue a token" endpoint yet.

```json
{ "id": "bld_mabc123_a1b2c3d4", "filename": "Example-release.apk", "downloadTokenEnabled": false }
```

### `GET /download/:token/:filename`

No auth — the 64-character hex token **is** the bearer credential.
Permanent, non-expiring, unguessable (SHA-256 of 32 random bytes).
Streams the file, or `404` if the token is invalid, disabled, or doesn't
match that exact filename.

## API keys

### `POST /api/v1/api-keys`

Scope: `api-key:manage`.

```json
{ "name": "ci-bot", "scopes": ["build:create", "build:read", "build:logs"] }
```

`scopes` omitted or `null` → full access. Unknown scope names → `400`.

```json
{ "id": 4, "name": "ci-bot", "scopes": ["build:create", "build:read", "build:logs"], "key": "abs_..." }
```

`key` is shown **once** — same guarantee as
`scripts/create-api-key.mjs`, not recoverable afterward, only the hash is
stored.

### `GET /api/v1/api-keys`

Scope: `api-key:manage`. Lists every key (no plaintext, ever):

```json
{ "apiKeys": [{ "id": 4, "name": "ci-bot", "createdAt": "...", "enabled": true, "scopes": ["build:create"] }] }
```

### `DELETE /api/v1/api-keys/:id`

Scope: `api-key:manage`. Disables (doesn't delete the row) a key.

```json
{ "id": 4, "enabled": false }
```

## Metrics & system (admin)

### `GET /api/v1/metrics`

Scope: `metrics:read`.

```json
{ "buildsByStatus": { "completed": 12, "failed": 2 }, "averageDurationMs": 184300, "durationSampleCount": 12 }
```

### `GET /api/v1/system`

Scope: `system:manage`. Powers the web UI's Admin page.

```json
{
  "version": "1.0.0",
  "lastBootAt": "2026-09-21T18:00:00.000Z",
  "activeBuild": false,
  "queuedBuilds": 0,
  "latestVersion": "1.0.0",
  "checked": true,
  "updateAvailable": false
}
```

`checked: false` (and no `latestVersion`) if `GITHUB_REPO` isn't set or
GitHub's API was unreachable — never fails the request.

### `GET /api/v1/system/logs`

Scope: `system:manage`. Query params: `lines` (default 200, max 2000),
`level` (`info`/`warn`/`error`). Tails the API's own operational log —
not a build's log (see `GET /api/v1/builds/:id/logs` for that).

```json
{ "entries": [{ "ts": "2026-09-21T18:00:00.000Z", "level": "info", "source": "api", "msg": "Build API listening", "port": 8080 }] }
```

### `POST /api/v1/system/backup`

Scope: `system:manage`. Runs the same `runBackup()` logic as
`scripts/backup.mjs` in-process.

```json
{ "archivePath": "/app/backups/build-server-v1.0.0-2026-09-21T18-00-00-000Z.tar.gz", "version": "1.0.0", "envIncluded": true }
```

`500` with `{"error": "..."}` if the database file isn't found or the
snapshot fails.

### `POST /api/v1/system/update`

Scope: `system:manage`. Triggers a real `scripts/update.sh` run via a
sibling container — see `docs/deployment.md`'s Admin page section for
exactly how and why. Body (optional):

```json
{ "targetRef": "v1.2.3" }
```

Omit `targetRef` (or send `{}`) to update to the latest commit.

```json
{ "runnerName": "build-server-update-1758480000000", "targetRef": "v1.2.3" }
```

`202` means the sibling container was spawned, not that the update
finished — poll `GET /health` to watch the service come back. `409` with
a clear error if `HOST_PROJECT_DIR`/`API_IMAGE` aren't set (non-Compose
deployments, or misconfiguration).

## Error shape

Every error response is `{"error": "human-readable message"}` with an
appropriate status code — `400` (bad request), `401` (missing/invalid
key), `403` (valid key, wrong scope), `404` (not found, or found but not
yours), `409` (conflict — already in a terminal state, or misconfigured
for the requested action), `500` (unexpected failure). There's no
machine-readable error code field; match on status code and, if needed,
the message text.
