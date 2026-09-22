# Wiring a project to build here

This is for connecting a project's own CI/deploy pipeline to
build-server, so a push/tag/release in *that* project automatically
triggers an Android build here — the same shape as how Expo's EAS Build
plugs into a CI pipeline: one persistent, scoped credential, one HTTP
call to kick off a build, poll for it to finish, grab the artifact.

For the full endpoint-by-endpoint contract, see
[api-reference.md](api-reference.md) — this doc is the task-oriented
walkthrough; that one is the reference.

## 1. Create a scoped API key

Do this from **your own account** — the key lives in your profile, and
every build it submits belongs to your workspace (visible in the
Dashboard, isolated from every other account, including admins).

**Via the web UI** (Profile → My API keys → Create new key) gives the
key full access to your own workspace. That's fine for a single trusted
CI pipeline, since it still can't touch anyone else's builds or any
admin action regardless.

**Via the CLI**, if you want to lock it down to exactly what a deploy
pipeline needs — submit a build, check on it, grab the artifact, and
nothing else:

```bash
docker compose exec api node scripts/create-api-key.mjs "myapp-ci-deploy" \
  --scopes build:create,build:read,build:logs,artifact:download
```

Either way, the plaintext key (`abs_...`) is shown exactly once. Save it
now — there's no way to retrieve it again, only revoke it and create a
new one.

## 2. Store it as a CI secret

Same handling as any other deploy credential — never commit it:

```bash
# .env in the OTHER project (gitignored), or your CI platform's secret store
BUILD_SERVER_API_URL=https://builds-api.example.com
BUILD_SERVER_API_KEY=abs_...
```

For GitHub Actions specifically: **Settings → Secrets and variables →
Actions**, add `BUILD_SERVER_API_URL` and `BUILD_SERVER_API_KEY` there
instead of a committed `.env`.

## 3. Submit a build

```bash
curl -sf -X POST "$BUILD_SERVER_API_URL/api/v1/builds" \
  -H "Authorization: Bearer $BUILD_SERVER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "project": {
      "name": "MyApp",
      "source": { "type": "git", "url": "https://github.com/you/myapp.git", "ref": "main" }
    },
    "build": {
      "platform": "android",
      "variant": "release",
      "artifact": "aab",
      "env": { "EXPO_PUBLIC_API_URL": "https://myapp.example.com" },
      "secrets": { "ANDROID_GOOGLE_MAPS_API_KEY": "..." }
    }
  }'
```

Returns immediately (`202`):

```json
{ "id": "bld_mabc123_a1b2c3d4", "status": "queued" }
```

A few things worth getting right here specifically for a CI trigger:

- **`source.ref`** — pin it to whatever triggered this deploy (the tag
  being released, the commit SHA, the branch), not a floating `main`,
  so a build is always reproducible from the event that caused it. In
  GitHub Actions this is `${{ github.sha }}` or `${{ github.ref_name }}`.
- **`build.secrets`** vs **`build.env`** — anything that shouldn't show
  up in logs or API responses (API keys, signing credentials) goes in
  `secrets`; it's encrypted at rest while queued and masked (`***`)
  everywhere afterward. Plain config values go in `env`.
- The `git` source must be an `https://` URL reachable from wherever this
  server runs. For a **private** repo, add `source.auth: { "type":
  "token", "token": "..." }` — a GitHub fine-grained PAT scoped to
  read-only Contents access on just that repo is the right shape of
  credential. It's handed to `git` via `GIT_ASKPASS` at clone time, never
  embedded in the URL (which is itself written to the build log, unlike
  the token), and gets the same encrypted-at-rest/masked-everywhere-else
  treatment as `build.secrets` above. Don't embed a token directly in
  `source.url` (`https://<token>@github.com/...`) — that URL is logged
  verbatim, so the token would leak into the build's own log.

## 4. Poll until it's done

There's no webhook/callback yet — polling `GET /api/v1/builds/:id` is
the whole mechanism. A simple bash loop:

```bash
BUILD_ID="bld_mabc123_a1b2c3d4"   # from the submit response

while true; do
  STATUS=$(curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID" \
    -H "Authorization: Bearer $BUILD_SERVER_API_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')

  echo "Build status: $STATUS"

  case "$STATUS" in
    completed) echo "Build succeeded."; break ;;
    failed|cancelled) echo "Build did not succeed."; exit 1 ;;
    *) sleep 15 ;;
  esac
done
```

Only one build runs at a time on this server by design — a `queued`
build can sit for a while behind whatever's already `building`. Size
your CI job's timeout accordingly (a full Android release build
typically takes several minutes once it starts; add queue wait time on
top for a busy server). If a build hangs well past what's normal, check
the failure reason:

```bash
curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID" \
  -H "Authorization: Bearer $BUILD_SERVER_API_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).failureReason'
```

or the full build log:

```bash
curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID/logs" \
  -H "Authorization: Bearer $BUILD_SERVER_API_KEY"
```

## 5. Get the artifact

```bash
curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID/artifacts" \
  -H "Authorization: Bearer $BUILD_SERVER_API_KEY"
```

```json
{
  "id": "bld_mabc123_a1b2c3d4",
  "artifacts": [
    { "filename": "MyApp-release.aab", "size": 41200000, "downloadUrl": "https://builds-api.example.com/download/<token>/MyApp-release.aab" }
  ]
}
```

`downloadUrl` is permanent and needs no auth to fetch — treat it as a
credential in its own right (anyone with the link can download the
file), but it's exactly what you want for the next step of a deploy
pipeline (uploading to a Play Store track, attaching to a GitHub
Release, etc.), since nothing downstream needs your API key at all:

```bash
curl -sfL -o MyApp-release.aab "$(curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID/artifacts" \
  -H "Authorization: Bearer $BUILD_SERVER_API_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).artifacts[0].downloadUrl')"
```

## Full example: GitHub Actions

```yaml
name: Deploy Android build

on:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      BUILD_SERVER_API_URL: ${{ secrets.BUILD_SERVER_API_URL }}
      BUILD_SERVER_API_KEY: ${{ secrets.BUILD_SERVER_API_KEY }}
    steps:
      - name: Submit the build
        id: submit
        run: |
          RESPONSE=$(curl -sf -X POST "$BUILD_SERVER_API_URL/api/v1/builds" \
            -H "Authorization: Bearer $BUILD_SERVER_API_KEY" \
            -H "Content-Type: application/json" \
            -d "{
              \"project\": {
                \"name\": \"MyApp\",
                \"source\": { \"type\": \"git\", \"url\": \"https://github.com/${{ github.repository }}.git\", \"ref\": \"${{ github.sha }}\" }
              },
              \"build\": { \"platform\": \"android\", \"variant\": \"release\", \"artifact\": \"aab\" }
            }")
          echo "id=$(echo "$RESPONSE" | jq -r .id)" >> "$GITHUB_OUTPUT"

      - name: Wait for it to finish
        id: wait
        run: |
          BUILD_ID="${{ steps.submit.outputs.id }}"
          for i in $(seq 1 80); do   # ~20 min at 15s intervals
            STATUS=$(curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID" \
              -H "Authorization: Bearer $BUILD_SERVER_API_KEY" | jq -r .status)
            echo "status: $STATUS"
            [ "$STATUS" = "completed" ] && break
            if [ "$STATUS" = "failed" ] || [ "$STATUS" = "cancelled" ]; then
              echo "::error::Build $STATUS"
              curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID/logs" \
                -H "Authorization: Bearer $BUILD_SERVER_API_KEY"
              exit 1
            fi
            sleep 15
          done

      - name: Download the artifact
        run: |
          BUILD_ID="${{ steps.submit.outputs.id }}"
          URL=$(curl -sf "$BUILD_SERVER_API_URL/api/v1/builds/$BUILD_ID/artifacts" \
            -H "Authorization: Bearer $BUILD_SERVER_API_KEY" | jq -r '.artifacts[0].downloadUrl')
          curl -sfL -o MyApp-release.aab "$URL"

      - uses: actions/upload-artifact@v4
        with:
          name: MyApp-release
          path: MyApp-release.aab
```

(Uses `jq` — available by default on GitHub's `ubuntu-latest` runners;
swap for the `node -pe ...` one-liners above if your CI image doesn't
have it.)

## Troubleshooting

**`401 Unauthorized`** — the key is wrong, was revoked, or the request
never actually included the header (check for a typo in the secret
name, or that it's actually being interpolated into the `curl` command
rather than sent literally as `$BUILD_SERVER_API_KEY`).

**`403` with `API key missing required scope: ...`** — the key doesn't
have that scope. Either create a new key with the right scopes (Step 1)
or revoke and replace this one — scopes can't be edited after creation.

**`404` on a build you just submitted** — almost always the wrong key
being used to check on it. A build is scoped to the account whose key
submitted it; a different key (even your own second key, if you use
more than one) can't see it. Reuse the exact same key across submit and
poll/download.

**Git source rejected** — the source URL must be `https://`, and must
not resolve to a private/internal address, unless this deployment has
opted into `ALLOW_LOCAL_GIT_SOURCES=true` (ask whoever administers it).

**`Git clone failed` in the build log, private repo** — check
`source.auth.token` is actually set and hasn't expired/been revoked, and
that it has read access to that specific repo (a fine-grained PAT scoped
too narrowly is the usual cause). The log deliberately won't show the
token itself, only that credentials were provided — see Security notes.

**Nothing happens / build sits `queued` forever** — only one build runs
at a time on this server, across every account. Check
`GET /api/v1/metrics` (your own key's workspace) or ask an admin to
check the Admin Overview tab for the current queue depth — a long queue
isn't a bug, just contention.

## Security notes

- Treat `BUILD_SERVER_API_KEY` exactly like any other deploy credential
  (a cloud provider key, a signing certificate password) — CI secret
  store, never a committed file, rotated if you suspect it leaked.
- Scope it to the minimum a deploy pipeline actually needs
  (`build:create,build:read,build:logs,artifact:download` covers submit
  → poll → download; add `build:cancel` only if your pipeline needs to
  cancel a stuck build itself).
- Revoking a key is immediate and irreversible — anything still using
  it starts getting `401` on its very next request. There's no "pause"
  state, only active or revoked.
- The key can never do anything outside your own workspace or reach any
  admin action (server updates, user management), no matter how it's
  scoped — that boundary isn't something a scope can widen.
