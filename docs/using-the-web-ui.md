# Using the web UI

This is for actually using the dashboard — submitting builds, checking on
them, downloading artifacts. If you're setting the web UI up on a server,
see [deployment.md](deployment.md#web-ui-optional) instead.

## Getting an account

Every account is real: a username and password, plus a mandatory
second factor (TOTP via an authenticator app — Google Authenticator,
Authy, 1Password, etc.). There's no way to skip the second factor, and
no way to sign in with just an API key — that's a separate, narrower
thing (see API keys, below).

Two ways to get an account:

- **An admin invites you directly.** They'll send you a one-time link
  (`#/signup?token=...`). Open it, set a password, and you'll be walked
  straight into scanning a QR code to finish setup.
- **Request access yourself.** Click **Need an account?** on the sign-in
  page, fill in a username (and optionally an email/message so an admin
  knows who's asking), answer the simple math check, and submit. An
  admin reviews it and, if approved, sends you an invite link the same
  way as above — submitting a request doesn't create an account by
  itself.

## Signing in

Username and password, then a 6-digit code from your authenticator app
(or one of your recovery codes, shown to you once when you finished
enrolling — see Profile below). If sign-in fails, the error is specific:
wrong username/password, or an invalid/expired code.

There's no "API base URL" field to fill in anymore — the web UI already
knows where its API is (set once by whoever deployed it).

**Everything you see is scoped to your own account.** Builds, logs,
artifacts, API keys — none of it is visible to any other user, including
admins. The one exception is a broadcast notification an admin sends to
everyone (shown as a dismissible banner at the top of the page) — that's
deliberate and the only thing that ever crosses accounts.

## Dashboard

The **Dashboard** (the page you land on after signing in) lists your own
builds. Each row shows the project name, current status, platform, and
when it was submitted. Click a project name to open that build's detail
page. The list refreshes itself every 5 seconds, or click **Refresh** to
force it.

**Status meanings:**

| Status | Meaning |
|---|---|
| `queued` | Waiting — only one build runs at a time, so this one is next in line. |
| `building` | Actively running inside an isolated container right now. |
| `completed` | Finished successfully — check the build's Artifacts section. |
| `failed` | Something went wrong — open the build and check its Logs. |
| `cancelled` | Someone cancelled it before it finished. |

## Submitting a build

Click **Submit build** in the top nav. The form:

- **Project name** — anything descriptive; it's just a label, shown on
  the dashboard and in the build's own page.
- **Source type** — `git` for a GitHub/GitLab-style HTTPS repository
  (the normal case), or `directory` (only meaningful for trusted/internal
  deployments pointed at a path already on the server — ask your admin
  if you're not sure this applies to you).
- **Git URL** (or directory path) — for `git`, must be an `https://` URL.
  Non-HTTPS and internal/private-network addresses are rejected outright
  as a security measure, unless this specific deployment has explicitly
  opted into allowing them.
- **Git ref** (optional) — a branch, tag, or commit to build; leave blank
  for the repository's default branch.
- **Project root** (optional) — if the Android project isn't at the
  repository root (a monorepo with `app/`, `server/`, etc. alongside each
  other), give the relative path to it, e.g. `app`.
- **Variant** — `release` or `debug`.
- **Artifact** — `apk` or `aab`.
- **Environment variables** (optional) — a JSON object of plain,
  non-secret values the build needs, e.g.
  `{"EXPO_PUBLIC_API_URL":"https://example.com"}`.
- **Secrets** (optional) — a JSON object of values that must not be
  exposed, e.g. `{"ANDROID_GOOGLE_MAPS_API_KEY":"..."}`. These are
  encrypted while the build waits in the queue, and masked everywhere
  they'd otherwise show up — logs, this dashboard, the API — the moment
  the build starts. There's no way to view a secret back out once
  submitted, by design.

Click **Submit build** and you're taken straight to that build's detail
page.

## Build detail

Shows the build's status, platform/variant/artifact, timestamps, and:

- **Artifacts** — once a build completes, its `.apk`/`.aab` appears here
  as a direct download link. This link is permanent and doesn't require
  signing in to use — you can share it with anyone who needs the file
  (that's intentional; treat the link itself as a credential, since
  anyone who has it can download the artifact).
- **Logs** — the build's real output. If a build fails, this is where to
  look — the failure reason shown above the log is a short summary, the
  log itself has the detail.
- **Cancel build** — shown only while a build is still `queued` or
  `building`. Stops it and marks it `cancelled`.

This page also auto-refreshes every few seconds while you have it open.

## Profile

Your own account settings:

- **Change password** — needs your current password.
- **Two-factor authentication** — shows whether it's enrolled (always,
  once you've finished signing up) and lets you **regenerate recovery
  codes** (needs your current password; invalidates every code issued
  before). If you lose your authenticator app entirely, an admin has to
  reset your enrollment from their side — there's no self-service
  recovery for that.
- **My API keys** — create or revoke keys for scripted/CI access (a
  `curl`/CI job, not a browser). A key you create here is scoped to
  *your* builds only — never anyone else's, and never able to manage
  users or the server. Each key's plaintext is shown exactly once, right
  when you create it; save it somewhere real, since it can't be
  retrieved again, only revoked and replaced. See
  [api-reference.md](api-reference.md) for using a key directly (e.g.
  from a CI pipeline) instead of through this UI.

## Admin page

Requires an admin account, **signed in** — an API key, even a
full-access one, can never reach this page or its underlying endpoints.
Five tabs:

- **Overview** — running version (and whether a newer one's available,
  if this deployment checks GitHub), a real **Update now** / **Back up
  now** trigger, the build queue's current depth, and a tail of the
  service's own operational log. "Total builds across every account" is
  a bare count for capacity planning — it doesn't expose any individual
  build's content.
- **Users** — every account (username, role, 2FA status, enabled/
  disabled, last login). Promote/demote, enable/disable, force a
  password reset (generates a link for you to send the user — this repo
  doesn't send email itself) or force 2FA re-enrollment (for a lost
  authenticator). You can't disable or demote your own account, on
  purpose. This never shows any user's builds, logs, or keys — admin
  manages *accounts*, not account *data*.
- **Invites** — create a one-time signup link for a specific role
  (optionally pre-filled with a suggested username), see pending/used/
  expired invites, and revoke an unused one.
- **Signup requests** — anyone who used "Request access" on the sign-in
  page shows up here. **Approve** (choosing their role) turns it into an
  invite link the same as above; **Reject** just marks it decided.
- **Broadcast** — send a message that appears as a dismissible banner
  for every signed-in user. This is the one deliberate exception to
  every account's isolation from every other — use it for things like
  "restarting the server for an update shortly."

## Getting help

- For what each API endpoint actually does under the hood — including
  using an API key directly instead of through this UI — see
  [api-reference.md](api-reference.md).
- For deploying or configuring the web UI itself, see
  [deployment.md](deployment.md#web-ui-optional).
