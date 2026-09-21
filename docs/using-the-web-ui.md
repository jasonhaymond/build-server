# Using the web UI

This is for actually using the dashboard — submitting builds, checking on
them, downloading artifacts. If you're setting the web UI up on a server,
see [deployment.md](deployment.md#web-ui-optional) instead.

## Signing in

You'll need two things from whoever administers this deployment:

- **The API base URL** — where the build-server API itself lives (not the
  web UI's own address). Something like `https://builds-api.example.com`
  — commonly on a distinguishing subdomain from the web UI's own address
  (e.g. `https://builds.example.com`), so don't assume they're the same
  hostname.
- **An API key** — a string starting with `abs_`, created for you with
  `scripts/create-api-key.mjs` or the Admin page's API key tooling. It's
  shown to whoever created it exactly once, so if you don't have one yet,
  ask them for it directly (it can't be looked up or recovered after the
  fact — only replaced with a new one).

Open the web UI, paste both into the sign-in form, and sign in. The key
is stored only in that browser tab's session storage — it's never sent
anywhere but this API, and it's gone the moment you sign out or close the
tab. You'll need to paste it again next time; that's intentional, not a
bug.

If sign-in fails, the error message is the API's own — most commonly
"Unauthorized" (the key was mistyped, or has been revoked) or a
connection error (wrong base URL, or the server is down).

**What you can do depends on what your key is scoped for.** A key might
only be able to submit builds and watch its own, or it might also see
every client's builds, manage other keys, or reach the Admin page. If
something in this guide 403s for you ("API key missing required scope:
..."), that action isn't part of what your key was granted — ask whoever
administers this deployment.

## Dashboard

The **Dashboard** (the page you land on after signing in) lists builds —
your own, or every client's if your key has that kind of access. Each row
shows the project name, current status, platform, and when it was
submitted. Click a project name to open that build's detail page. The
list refreshes itself every 5 seconds, or click **Refresh** to force it.

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

## Admin page

Only visible in the sense that it's always in the nav, but everything on
it requires your key to have admin-level access — otherwise you'll see a
single "missing required scope" message instead of the page contents.
If you have access:

- **Version** — what's currently running, and (if this deployment checks
  GitHub for updates) whether a newer version exists.
- **Update now** — redeploys the service to the latest version, or to a
  specific tag if you type one in first. This is a real action with real
  consequences — it briefly restarts the live service — so it asks you
  to confirm before doing anything.
- **Back up now** — snapshots the database and configuration to the
  server's `backups/` directory on demand. Doesn't need a confirmation;
  it's not destructive.
- **Queue** — how many builds are waiting/running right now, plus a
  breakdown of build counts by status and average build duration.
- **API log** — the service's own operational log (not any one build's
  log), for diagnosing problems with the service itself.

## Getting help

- If an action fails with a scope-related error, that's about what your
  specific key can do, not a bug — ask your deployment's admin.
- For what each API endpoint actually does under the hood, see
  [api-reference.md](api-reference.md).
- For deploying or configuring the web UI itself, see
  [deployment.md](deployment.md#web-ui-optional).
