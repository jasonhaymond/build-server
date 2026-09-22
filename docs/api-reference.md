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

Two independent methods — both resolve to an acting workspace, but
they're not interchangeable:

- **A signed-in session** (real HTTP auth — username/password + mandatory
  TOTP, see Auth below) — a browser cookie, `bs_session`, set by
  `POST /api/v1/auth/login/mfa` or the enrollment-confirm endpoints. A
  session gets the full non-admin permission set for its own workspace,
  with no per-request scope narrowing — that's what API keys are for.
  Admin-only actions (`/api/v1/admin/*`, `/api/v1/system/*`) additionally
  require the session's account to hold the `admin` role.
  Every mutating request (non-`GET`) from a session must also echo
  `X-CSRF-Token: <token>`, matching the token returned at login/
  enrollment — the cookie is `httpOnly` specifically so page JavaScript
  can't read it, so this header is the actual proof of intent. A missing
  or wrong token is a `403`.
- **A Bearer API key**:
  ```http
  Authorization: Bearer <API_KEY>
  ```
  Keys are created from a signed-in user's own profile
  (`POST /api/v1/api-keys`) or with `scripts/create-api-key.mjs` (for a
  key with no user attached — a legacy-style, unowned key). They begin
  with `abs_` and are shown once — the server stores only a SHA-256
  hash. A key created with no scopes has full access to the remaining
  (non-admin) actions; a scoped key only has what it was explicitly
  granted. **No scope grants any admin action** — `/api/v1/admin/*` and
  `/api/v1/system/*` are unreachable via any API key, however
  permissive, by design (a leaked CI key can never trigger a server
  update, back up, or manage accounts).

`GET /health` and `GET /download/:token/:filename` need neither —
`/health` is meant for external uptime monitors, and the download URL
itself is the bearer credential (see Permanent download tokens below).
The `POST /api/v1/auth/*`, `GET /api/v1/auth/invites/:token`, and
`/api/v1/request-access*` routes are also unauthenticated by design (see
Auth below) — that's how you get a session in the first place.

### Scopes

Only relevant to a Bearer API key — a session isn't scope-narrowed.

| Scope | Grants |
|---|---|
| `build:create` | `POST /api/v1/builds` |
| `build:read` | `GET /api/v1/builds`, `GET /api/v1/builds/:id` (own builds only — see Isolation) |
| `build:logs` | `GET /api/v1/builds/:id/logs` |
| `build:cancel` | `POST /api/v1/builds/:id/cancel` |
| `artifact:download` | `GET /api/v1/builds/:id/artifacts`, `GET /api/v1/builds/:id/artifacts/:filename` |
| `artifact:manage` | `DELETE /api/v1/builds/:id/artifacts/:filename/download-token` |
| `metrics:read` | `GET /api/v1/metrics` |

`GET /api/v1/whoami` requires a valid session or key but no particular
scope — it's what the web UI uses to verify/restore sign-in without
assuming any scope, so a narrowly-scoped key isn't locked out of signing
in.

### Isolation

Every build, API key, and metric belongs to exactly one workspace,
identified by `user_id` (a real account) or, for a key with no user
attached, the key's own `api_key_id` — **absolute**, with no bypass of
any kind, for any role. An admin session has exactly the same build/key
visibility as any other account: none, for anyone else's. Mismatches
return **404, not 403** — the wrong owner can't tell a build/key ID
exists at all. A build or key that predates all of this (no `user_id`,
created before v2.0.0) keeps its exact pre-v2.0.0 behavior: visible to
the `api_key_id` that owns it, or to any other equally-unowned key if
neither side ever had an owner recorded — but never to a real user
account, and never to any key that does have a `user_id`.

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

## Auth

Everything here is unauthenticated (that's the point) unless noted.
Rate-limited by IP and, where applicable, username — repeated failures
get a `429`.

### `POST /api/v1/auth/login`

```json
{ "username": "jason", "password": "..." }
```

`401` on any mismatch (wrong username or password — never which one).
On success, one of:

```json
{ "mfaToken": "..." }
```

or, if this account hasn't finished TOTP enrollment yet (a freshly
bootstrapped or reset-2FA account):

```json
{ "needsEnrollment": true, "enrollmentToken": "..." }
```

### `POST /api/v1/auth/login/mfa`

```json
{ "mfaToken": "...", "code": "123456" }
```

`code` is a 6-digit TOTP code or one of the account's recovery codes
(single-use — consumed on success). `401` for a wrong code, `410` if
`mfaToken` is unknown/expired (the login step needs repeating). On
success, sets the `bs_session` cookie and returns:

```json
{ "user": { "id": 3, "username": "jason", "role": "admin" }, "csrfToken": "..." }
```

### `POST /api/v1/auth/logout`

Requires a session (+ CSRF header). Deletes the session row and clears
the cookie. `204`.

### `GET /api/v1/auth/invites/:token`

Validates an invite without redeeming it.

```json
{ "purpose": "signup", "role": "user", "suggestedUsername": "jason" }
```

`404` if unknown, already used, or expired. `purpose` is `"signup"` or
`"password_reset"` (the latter has `role`/`suggestedUsername` as `null`).

### `POST /api/v1/auth/invites/:token/complete`

For `purpose: "signup"`:

```json
{ "username": "jason", "password": "..." }
```

(`username` only needed if the invite didn't already fix one via
`suggestedUsername`.) Creates the account and returns an enrollment
token — no session yet, since 2FA isn't done:

```json
{ "enrollmentToken": "..." }
```

For `purpose: "password_reset"`, just `{"password": "..."}` — updates
the existing account's password and returns `{"ok": true}`, no session.

`400` for a too-short password (12 chars minimum) or (`signup` only) a
taken username; `409` for a taken username specifically.

### `POST /api/v1/auth/enroll/start`

```json
{ "enrollmentToken": "..." }
```

Generates a fresh TOTP secret and returns it plus a scannable QR:

```json
{ "secret": "JBSWY3DPEHPK3PXP", "qrCodeDataUrl": "data:image/png;base64,..." }
```

### `POST /api/v1/auth/enroll/confirm`

```json
{ "enrollmentToken": "...", "code": "123456" }
```

`401` for a wrong code, `410` if the token is expired or `enroll/start`
was never called. On success, enrolls TOTP, generates 8 recovery codes,
sets the session cookie, and returns:

```json
{ "user": { "id": 3, "username": "jason", "role": "user" }, "csrfToken": "...", "recoveryCodes": ["a1b2c-3d4e5", "..."] }
```

`recoveryCodes` is shown **once** — there's no way to retrieve it again,
only regenerate (`POST /api/v1/me/recovery-codes`, which invalidates
these).

### `GET /api/v1/request-access/challenge`

Stateless — no DB row. Returns a small arithmetic challenge, signed so
`POST /api/v1/request-access` can verify it without having stored
anything:

```json
{ "challengeId": "3.5.1758480000000.<hmac>", "question": "3 + 5" }
```

### `POST /api/v1/request-access`

```json
{
  "username": "wants-in",
  "email": "them@example.com",
  "message": "optional",
  "honeypot": "",
  "challengeId": "...",
  "answer": 8
}
```

`honeypot` must be sent empty (a real form leaves it blank; it's hidden
from human users via CSS, not `display:none`). Always responds `202`
with a generic acknowledgement — including when the submission looks
bot-shaped (honeypot filled in, or submitted less than 3 seconds after
the challenge was fetched), which is silently discarded instead of
inserted, so there's no way to tell from the response which check a bot
tripped. A genuinely wrong answer gets a real `400` (visible math
challenges are expected to give feedback). Rate-limited to 5 per hour
per IP.

## Identity

### `GET /api/v1/whoami`

Any valid session or key.

```json
{ "id": 3, "name": "ci-bot", "scopes": ["build:create", "build:read"], "authMethod": "apiKey" }
```

```json
{ "id": 3, "username": "jason", "role": "admin", "authMethod": "session", "csrfToken": "..." }
```

`scopes` is `null` for a full-access key. `csrfToken` (session responses
only) lets the web UI re-establish a usable token after a page reload,
since it's otherwise only ever handed out once, at login/enrollment.

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
`offset` (default 0). Always scoped to the caller's own workspace — see
Isolation above.

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

## Profile (session only)

Every route here requires a signed-in session — never an API key, even
a full-access one.

### `POST /api/v1/me/password`

```json
{ "currentPassword": "...", "newPassword": "..." }
```

`401` if `currentPassword` is wrong, `400` if `newPassword` is under 12
characters. `{"ok": true}` on success.

### `POST /api/v1/me/recovery-codes`

```json
{ "currentPassword": "..." }
```

Regenerates recovery codes without touching the TOTP secret itself —
old codes (used or not) stop working immediately. `401` for the wrong
password, `409` if TOTP isn't enrolled yet.

```json
{ "recoveryCodes": ["a1b2c-3d4e5", "..."] }
```

Shown once, same as at enrollment.

## API keys

Session-only (never satisfiable via another API key) — always scoped to
the signed-in account.

### `POST /api/v1/api-keys`

```json
{ "name": "ci-bot", "scopes": ["build:create", "build:read", "build:logs"] }
```

`scopes` omitted or `null` → full access to the non-admin action set.
Unknown scope names → `400` (this includes any pre-v2.0.0 admin scope —
they're gone, not just unassignable).

```json
{ "id": 4, "name": "ci-bot", "scopes": ["build:create", "build:read", "build:logs"], "key": "abs_..." }
```

`key` is shown **once** — same guarantee as
`scripts/create-api-key.mjs`, not recoverable afterward, only the hash is
stored. Belongs to the signed-in account — see Isolation above.

### `GET /api/v1/api-keys`

Lists the signed-in account's own keys only (no plaintext, ever):

```json
{ "apiKeys": [{ "id": 4, "name": "ci-bot", "createdAt": "...", "enabled": true, "scopes": ["build:create"] }] }
```

### `DELETE /api/v1/api-keys/:id`

Disables (doesn't delete the row) a key — `404` if it doesn't exist or
belongs to a different account.

```json
{ "id": 4, "enabled": false }
```

## Metrics & system (admin)

### `GET /api/v1/metrics`

Scope: `metrics:read` (or any signed-in session). Scoped to the caller's
own workspace.

```json
{ "buildsByStatus": { "completed": 12, "failed": 2 }, "averageDurationMs": 184300, "durationSampleCount": 12 }
```

### `GET /api/v1/system`

Admin session required (role, not a scope — unreachable via any API
key). Powers the web UI's Admin Overview tab.

```json
{
  "version": "2.0.0",
  "lastBootAt": "2026-09-21T18:00:00.000Z",
  "activeBuild": false,
  "queuedBuilds": 0,
  "totalBuildsAllUsers": 47,
  "latestVersion": "2.0.0",
  "checked": true,
  "updateAvailable": false
}
```

`checked: false` (and no `latestVersion`) if `GITHUB_REPO` isn't set or
GitHub's API was unreachable — never fails the request.
`totalBuildsAllUsers` is a bare count, not per-build detail — safe under
absolute isolation.

### `GET /api/v1/system/logs`

Admin session required. Query params: `lines` (default 200, max 2000),
`level` (`info`/`warn`/`error`). Tails the API's own operational log —
not a build's log (see `GET /api/v1/builds/:id/logs` for that).

```json
{ "entries": [{ "ts": "2026-09-21T18:00:00.000Z", "level": "info", "source": "api", "msg": "Build API listening", "port": 8080 }] }
```

### `POST /api/v1/system/backup`

Admin session required. Runs the same `runBackup()` logic as
`scripts/backup.mjs` in-process.

```json
{ "archivePath": "/app/backups/build-server-v2.0.0-2026-09-21T18-00-00-000Z.tar.gz", "version": "2.0.0", "envIncluded": true }
```

`500` with `{"error": "..."}` if the database file isn't found or the
snapshot fails.

### `POST /api/v1/system/update`

Admin session required. Triggers a real `scripts/update.sh` run via a
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

## Admin (accounts, invites, signup requests, broadcasts)

Admin session required for everything in this section except the two
marked otherwise. Manages **accounts**, never account *data* — none of
this ever exposes a user's builds, logs, artifacts, or API keys.

### `GET /api/v1/admin/users`

```json
{ "users": [{ "id": 3, "username": "jason", "role": "admin", "totpEnabled": true, "enabled": true, "createdAt": "...", "lastLoginAt": "..." }] }
```

### `PATCH /api/v1/admin/users/:id`

```json
{ "enabled": false }
```

or `{"role": "admin"}`. `400` if you try to disable or demote your own
account (an admin can't lock themselves out this way). `404` if the
user doesn't exist. Returns the updated user in the same shape as the
list above.

### `POST /api/v1/admin/users/:id/reset-password`

No body. Creates a `password_reset` invite and returns a shareable link
— this repo sends no email itself, the admin copies/sends it manually.

```json
{ "link": "https://builds.example.com/#/password-reset?token=..." }
```

`link` is `null` if `WEB_UI_ORIGIN` isn't configured (build the URL
manually from the invite in that case).

### `POST /api/v1/admin/users/:id/reset-2fa`

No body. Clears TOTP enrollment — the account falls back into the same
forced-enrollment flow a new signup goes through, on its next
successful password check. For a lost authenticator; there's no
self-service equivalent.

```json
{ "id": 3, "totpEnabled": false }
```

### `POST /api/v1/admin/invites`

```json
{ "role": "user", "suggestedUsername": "jason", "expiresInHours": 72 }
```

`suggestedUsername` and `expiresInHours` (default 72) are optional.

```json
{ "id": 5, "link": "https://builds.example.com/#/signup?token=..." }
```

### `GET /api/v1/admin/invites`

```json
{ "invites": [{ "id": 5, "purpose": "signup", "role": "user", "suggestedUsername": "jason", "expiresAt": "...", "usedAt": null }] }
```

### `DELETE /api/v1/admin/invites/:id`

Revokes an unused invite. `204`.

### `GET /api/v1/admin/signup-requests`

```json
{ "signupRequests": [{ "id": 2, "requestedUsername": "wants-in", "email": "...", "message": "...", "status": "pending", "createdAt": "..." }] }
```

### `POST /api/v1/admin/signup-requests/:id/approve`

```json
{ "role": "user" }
```

Creates a signup invite pre-filled with the request's username and
returns its link, same shape as `POST /api/v1/admin/invites`. Marks the
request `approved`. `404` if it's not pending (already decided, or
doesn't exist).

### `POST /api/v1/admin/signup-requests/:id/reject`

No body. Marks the request `rejected`.

```json
{ "id": 2, "status": "rejected" }
```

### `POST /api/v1/admin/notifications`

```json
{ "message": "Restarting the server for an update shortly." }
```

Broadcasts to every account — the one deliberate exception to isolation.

```json
{ "id": 9 }
```

### `GET /api/v1/notifications`

**Any signed-in session** (not admin-only). Unread broadcasts for the
caller's own account.

```json
{ "notifications": [{ "id": 9, "message": "...", "createdAt": "..." }] }
```

### `POST /api/v1/notifications/:id/read`

**Any signed-in session.** Marks one notification read for the caller
only — dismissal never affects any other account. `204`.

## Error shape

Every error response is `{"error": "human-readable message"}` with an
appropriate status code — `400` (bad request), `401` (missing/invalid
credentials), `403` (valid credentials, wrong scope/role, or a missing/
invalid CSRF token on a session request), `404` (not found, or found but
not yours), `409` (conflict — already in a terminal state, or
misconfigured for the requested action), `410` (an expired/consumed
login, enrollment, or invite token), `429` (rate-limited — auth and
request-access endpoints only), `500` (unexpected failure). There's no
machine-readable error code field; match on status code and, if needed,
the message text.
