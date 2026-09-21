# android-build-server

A self-hosted, project-agnostic Android build service. It accepts
Android/Expo/React Native source and build configuration, builds it in an
isolated Docker container, stores the resulting APK/AAB, and returns a
permanent public download URL.

**Current version:** 0.1.0 — see [CHANGELOG.md](CHANGELOG.md) for release history.

Full architecture, API reference, security model, and the project roadmap
live in [PROJECT-SCOPE.md](PROJECT-SCOPE.md) — read that first for anything
beyond local setup.

## Requirements

- Node.js 20+
- Docker (for running isolated build containers)
- The `android-build-server:latest` build image, built from [Dockerfile](Dockerfile)

## Setup

```bash
npm install
cp .env.example .env   # edit PORT / PUBLIC_BASE_URL / ANDROID_BUILD_IMAGE as needed
docker build -t android-build-server:latest .
```

Create an API key (required for every authenticated endpoint):

```bash
node scripts/create-api-key.mjs "some client name"
```

The plaintext key is printed once and is not recoverable afterward — only
its SHA-256 hash is stored. Save it somewhere real before continuing.

## Running

```bash
npm run api      # starts the Express API on $PORT (default 8080)
```

The worker (`npm run worker`) is spawned automatically per build by the API
— you don't run it standalone except for manual debugging.

## Submitting a build

```bash
curl -X POST http://localhost:8080/api/v1/builds \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "project": {
      "name": "Example",
      "source": { "type": "git", "url": "https://github.com/example/project.git", "ref": "main" }
    },
    "build": { "platform": "android", "variant": "release", "artifact": "apk" }
  }'
```

See [PROJECT-SCOPE.md](PROJECT-SCOPE.md) for the full API reference
(build status, logs, artifacts, permanent download URLs) and for the
source-type/env/secrets schema.

## Deployment

Production runs behind a separate Caddy reverse proxy that terminates TLS.
Port 8080 must never be exposed directly to the Internet. See
[PROJECT-SCOPE.md](PROJECT-SCOPE.md) for the reverse-proxy config, host
firewall rules, and current known limitations before deploying anywhere new.

## Status

This is an early, actively-hardening prototype (v0.1.0). See
PROJECT-SCOPE.md's "Current Known Limitations" section for what's not yet
built (persistent queue/recovery, build cancellation, timeouts, retention,
etc.) before relying on it for anything beyond internal/trusted use.
