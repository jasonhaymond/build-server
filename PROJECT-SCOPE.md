# Android Build Server — Project Scope & Handoff

This document is the handoff specification for the self-hosted generic Android build service.

## Project Overview

The service accepts Android/Expo/React Native source and build configuration, builds it in an isolated Docker environment, stores APK/AAB artifacts, and returns permanent public download URLs.

The service must remain project-agnostic. Clocker is the primary test client, but there must be no Clocker-specific build logic on the build server.

Target architecture:

```text
Client
  │ HTTPS + API key
  ▼
https://builds.haymondtechnologies.com
  │
  ▼
Caddy reverse proxy
  │
  ▼
Android Build API
  │
  ▼
Persistent build queue
  │
  ▼
Isolated Docker build container
  ├── Node.js
  ├── Java
  ├── Android SDK
  ├── Gradle
  └── submitted source
  │
  ▼
APK / AAB
  │
  ▼
Artifact storage
  │
  ▼
Permanent public download URL
```

A future web UI must use this same API and must never invoke Gradle, Docker, SQLite, or build directories directly.

## Primary Goals

- Generic Android build service.
- Support Expo/React Native and standard Gradle Android projects.
- Support monorepos through a relative `projectRoot`.
- Accept source as directory, ZIP upload, or Git.
- Support Android debug/release APK/AAB builds.
- Accept arbitrary environment variables.
- Support separate build secrets.
- Isolate submitted code in Docker.
- Authenticate API clients with bearer API keys.
- Store build state in SQLite.
- Return permanent, shareable artifact URLs.
- Put HTTPS behind the separate Caddy reverse proxy.
- Eventually support multiple clients and a web UI.

## Source Types

### Directory

Primarily for trusted/internal testing:

```json
{
  "project": {
    "name": "Example",
    "source": {
      "type": "directory",
      "path": "/some/path"
    }
  }
}
```

This should not be treated as a public source mechanism.

### ZIP

```json
{
  "project": {
    "name": "Example",
    "source": {
      "type": "upload",
      "path": "/path/to/project.zip"
    }
  }
}
```

ZIP extraction currently checks absolute paths and `..` traversal. Symlink-entry protection is not yet implemented and must be added before arbitrary public ZIP uploads are enabled.

### Git

```json
{
  "project": {
    "name": "Example",
    "source": {
      "type": "git",
      "url": "https://github.com/example/project.git",
      "ref": "main"
    }
  }
}
```

Public arbitrary Git URLs create SSRF and network-access risks. Git fetching must eventually be isolated and/or restricted by protocol/host allowlists.

## Monorepo / Project Root

The submitted source can contain the Android project below the source root.

Example:

```text
submitted source
├── app/
├── shared/
├── server/
├── web/
└── package.json
```

Use:

```json
"projectRoot": "app"
```

The path must be relative to the submitted source root.

## Build Configuration

Current supported platform:

```text
android
```

Variants:

```text
debug
release
```

Artifacts:

```text
apk
aab
```

Example:

```json
{
  "build": {
    "platform": "android",
    "variant": "release",
    "artifact": "apk"
  }
}
```

Expected Gradle tasks include:

```text
assembleDebug
assembleRelease
bundleDebug
bundleRelease
```

The worker must derive the task from the requested platform, variant, and artifact rather than from a specific project.

## Environment Variables

Clients may send arbitrary environment variables:

```json
{
  "build": {
    "env": {
      "EXPO_PUBLIC_API_URL": "https://example.com",
      "SOME_UNUSED_VARIABLE": "hello"
    }
  }
}
```

Unknown or unused variables must be accepted.

Validate only variable-name syntax:

```regex
^[A-Za-z_][A-Za-z0-9_]*$
```

Accepted values are string, number, and boolean and are converted to strings before Docker execution.

Do not pass the host environment wholesale.

## Secrets

Secrets are separate:

```json
{
  "build": {
    "secrets": {
      "ANDROID_GOOGLE_MAPS_API_KEY": "secret-value"
    }
  }
}
```

Secrets must:

- reach the build container;
- never appear in logs;
- never appear in API responses;
- never be persisted in plaintext job records;
- never appear in Docker command logging;
- never be included in ordinary build metadata.

The current implementation masks secrets in persisted `job.json`, although the API process currently holds the full job in memory while queued/running.

## Security Model

Submitted source is arbitrary code. Never execute submitted source directly on the host.

Current Docker restrictions:

```text
--user UID:GID
--cpus 6
--memory 12g
--pids-limit 512
--security-opt no-new-privileges
```

Current build image contains:

- Node.js 20
- npm
- OpenJDK 17
- Android SDK
- platform tools
- Android API 36
- Android Build Tools 36.0.0
- Git
- unzip/zip
- wget/curl
- build-essential
- Python 3

Build-container networking is currently unrestricted and must eventually be hardened.

## Current Docker Build Image

Current Dockerfile:

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    git \
    unzip \
    zip \
    wget \
    ca-certificates \
    build-essential \
    python3 \
    openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
       -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/android-tools \
    && mv /tmp/android-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/cmdline-tools.zip /tmp/android-tools

ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}

RUN yes | sdkmanager --licenses >/dev/null || true \
    && sdkmanager \
       "platform-tools" \
       "platforms;android-36" \
       "build-tools;36.0.0" \
    && chmod -R a+rwX ${ANDROID_HOME}

WORKDIR /build

CMD ["/bin/bash"]
```

Image:

```text
android-build-server:latest
```

Verified container toolchain:

```text
Node       v20.20.2
npm        10.8.2
Java       OpenJDK 17.0.20
sdkmanager 19.0
Android    platform-tools 37.0.1
Android    API 36
Build tools 36.0.0
```

## Host Environment

Build server:

```text
hostname: apps
LAN IP:   10.1.30.65
API:      10.1.30.65:8080
```

The Node API listens on:

```text
*:8080
```

UFW is enabled. The separate Caddy reverse proxy is:

```text
10.1.30.43
```

UFW specifically allows:

```text
10.1.30.43 -> TCP 8080
```

Port 8080 must not be opened generally to the Internet.

## Reverse Proxy

Separate WebProxy server runs Caddy.

Public hostname:

```text
builds.haymondtechnologies.com
```

Caddy:

```caddyfile
builds.haymondtechnologies.com {
    reverse_proxy 10.1.30.65:8080
}
```

Caddy terminates HTTPS/TLS. The Node API does not need public TLS configuration.

## Public Base URL

The API uses:

```text
PUBLIC_BASE_URL=https://builds.haymondtechnologies.com
```

Trailing `/` is removed if supplied.

The API must return fully qualified URLs, not relative `/download/...` paths.

Example:

```text
https://builds.haymondtechnologies.com/download/<token>/app-release.apk
```

Development fallback is currently:

```text
http://localhost:8080
```

## API

Production base:

```text
https://builds.haymondtechnologies.com/api/v1
```

### Health

```http
GET /health
```

Public.

### Create build

```http
POST /api/v1/builds
```

Authenticated.

Example:

```json
{
  "project": {
    "name": "Clocker",
    "source": {
      "type": "git",
      "url": "https://github.com/example/Clocker.git",
      "ref": "main"
    },
    "projectRoot": "app"
  },
  "build": {
    "platform": "android",
    "variant": "release",
    "artifact": "apk",
    "env": {
      "EXPO_PUBLIC_API_URL": "https://example.com"
    },
    "secrets": {
      "ANDROID_GOOGLE_MAPS_API_KEY": "secret"
    }
  }
}
```

Returns HTTP 202.

### Get build

```http
GET /api/v1/builds/:id
```

Authenticated.

### Get logs

```http
GET /api/v1/builds/:id/logs
```

Authenticated.

### Get artifacts

```http
GET /api/v1/builds/:id/artifacts
```

Authenticated.

Expected response:

```json
{
  "id": "bld_example",
  "artifacts": [
    {
      "filename": "app-release.apk",
      "size": 95600000,
      "downloadUrl": "https://builds.haymondtechnologies.com/download/<token>/app-release.apk"
    }
  ]
}
```

### Authenticated artifact download

```http
GET /api/v1/builds/:id/artifacts/:filename
```

Authenticated.

Keep this endpoint even though public permanent URLs exist.

### Public artifact download

```http
GET /download/:token/:filename
```

No API key required.

The URL itself is the bearer credential.

URLs are intentionally:

- permanent
- shareable
- non-expiring
- cryptographically unguessable

A revoke mechanism is still required.

## Permanent Download Tokens

Current design:

1. Generate 32 random bytes.
2. SHA-256 them.
3. Use the 64-character lowercase hexadecimal digest as the public token.
4. Store that token in SQLite.
5. Reuse it for subsequent artifact listing requests.

Conceptually:

```text
randomBytes(32)
      |
      v
SHA-256
      |
      v
64-character token
      |
      +-- stored in database
      |
      +-- returned in permanent URL
```

Database table:

```text
artifact_download_tokens
```

Columns:

```text
id
token_hash
build_id
filename
created_at
enabled
```

`token_hash` currently contains the public token itself. This allows the stable URL to be returned on every artifact listing request without storing a second unrecoverable plaintext token.

Anyone possessing a permanent URL can download the artifact.

## Token Revocation

Not implemented yet.

Future authenticated endpoint could be:

```http
DELETE /api/v1/builds/:id/artifacts/:filename/download-token
```

Disable by setting:

```text
enabled = 0
```

## Authentication

Current authentication uses bearer API keys:

```http
Authorization: Bearer <API_KEY>
```

Keys begin with:

```text
abs_
```

Generation uses 32 random bytes and stores only a SHA-256 hash.

Database:

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
```

Current middleware:

1. Read Authorization header.
2. Verify Bearer format.
3. Hash supplied key.
4. Look up hash.
5. Require enabled.
6. Attach key identity to request.

No scopes yet.

Future scopes:

```text
build:create
build:read
build:logs
artifact:download
build:cancel
artifact:manage
api-key:manage
```

## Database

SQLite:

```text
data/build-server.db
```

WAL mode is enabled.

Current tables:

```text
api_keys
builds
artifact_download_tokens
```

Current `builds` fields include:

```text
id
project_name
status
submitted_at
started_at
completed_at
exit_code
error
```

Future metadata may include:

```text
submitted_by
source metadata
platform
variant
artifact type
duration
worker
failure reason
cancellation state
```

Never persist build secrets.

## Build Statuses

Intended statuses:

```text
queued
building
completed
failed
cancelled
```

Current queue is in memory. SQLite contains build state, but queued work is not reconstructed after restart.

## NEXT MAJOR TASK — Persistent Queue / Recovery

Implement persistent queue/recovery.

Requirements:

1. SQLite remains source of truth.
2. Queued builds survive API restart.
3. Queue is reconstructed on API startup.
4. Safely handle builds that were `building` when the API stopped.
5. Never run duplicate builds.
6. Preserve current API behavior.
7. Preserve permanent artifact URLs.
8. Preserve API authentication.
9. Preserve `PUBLIC_BASE_URL`.
10. Do not persist build secrets.
11. Add restart/recovery tests.
12. Do not add Clocker-specific logic.

A build that was `building` during an API crash must not simply be blindly requeued until it is known that its previous worker/container is gone.

## Current Worker

Main worker:

```text
src/worker/index.mjs
```

It accepts:

```text
node src/worker/index.mjs job.json
```

or JSON through stdin.

The API currently sends the job through stdin.

Worker responsibilities:

1. Read job.
2. Validate job.
3. Create build directories.
4. Stage source.
5. Clone Git or extract ZIP.
6. Determine project root.
7. Construct Docker environment.
8. Start isolated Docker container.
9. Capture logs.
10. Locate artifact.
11. Copy artifact to host storage.
12. Report success/failure.

## Build Directory Layout

```text
builds/<build-id>/
├── job.json
├── source/
├── work/
├── artifacts/
└── logs/
    └── build.log
```

Artifacts:

```text
builds/<build-id>/artifacts/
```

Logs:

```text
builds/<build-id>/logs/build.log
```

Persisted `job.json` masks secrets.

## Source Staging

Current staging excludes generated/sensitive paths including:

```text
node_modules
.git
.gradle
.env
.env.*
*.dump
*.backup
```

Required environment values are supplied explicitly by the client.

## ZIP Security

Current extraction checks:

- absolute paths
- Windows absolute paths
- `..` traversal

Symlink entries are NOT yet protected.

This must be fixed before arbitrary public ZIP uploads.

## Git Security

Current Git support uses `git clone`.

Public arbitrary Git URLs create:

- SSRF
- internal network access
- malicious Git server risks
- credential exposure
- resource exhaustion

Future design should consider:

- HTTPS-only
- provider allowlists
- rejecting `file://` and local paths for public requests
- cloning inside isolated build containers
- restricted network egress

## Docker Security

Current Docker command includes:

```text
--rm
--user UID:GID
--cpus 6
--memory 12g
--pids-limit 512
--security-opt no-new-privileges
```

Environment includes:

```text
HOME=/build/job/work/home
GRADLE_USER_HOME=/build/job/work/gradle-cache
NODE_ENV=production
```

Only explicitly supplied variables are passed.

Future hardening:

```text
network restrictions
read-only filesystem where practical
temporary filesystems
capability dropping
seccomp/AppArmor
ulimits
build timeout
network egress restrictions
container cleanup
```

## Resource Limits

Current build container:

```text
CPU: 6
Memory: 12 GB
PIDs: 512
```

Host has approximately:

```text
32 GB RAM
```

Build concurrency is currently effectively one build.

Future concurrency must be configurable and resource-aware.

## Clocker Validation

Clocker is the primary real-world test.

Repository structure:

```text
Clocker/
├── app/
├── server/
├── web/
├── shared/
├── scripts/
└── package.json
```

Android project:

```text
app/
```

Therefore:

```json
"projectRoot": "app"
```

Clocker:

```text
Expo SDK 57
React Native 0.86.3
Node 20.20.2
Java 17
```

A Clocker release build has successfully completed directly and through the generic build worker.

## Clocker Environment Requirements

Clocker currently uses:

```text
ANDROID_GOOGLE_MAPS_API_KEY
EXPO_PUBLIC_API_URL
```

The Maps key is a secret.

The API URL is a normal environment variable.

The generic build server must not special-case these variables.

## Proven Clocker Build

A Clocker build was successfully submitted through the API using local Git source:

```json
{
  "project": {
    "name": "Clocker",
    "source": {
      "type": "git",
      "url": "/home/jason/Clocker",
      "ref": "master"
    },
    "projectRoot": "app"
  },
  "build": {
    "platform": "android",
    "variant": "release",
    "artifact": "apk",
    "env": {
      "EXPO_PUBLIC_API_URL": "https://clocker.haymondtechnologies.com"
    }
  }
}
```

The actual `ANDROID_GOOGLE_MAPS_API_KEY` was passed as a secret.

The build succeeded.

The APK was successfully downloaded through the authenticated API.

The permanent public download URL also succeeded.

## Current Production URLs

Service:

```text
https://builds.haymondtechnologies.com
```

Health:

```text
https://builds.haymondtechnologies.com/health
```

API:

```text
https://builds.haymondtechnologies.com/api/v1
```

Permanent downloads:

```text
https://builds.haymondtechnologies.com/download/<token>/<filename>
```

## Current Project Files

```text
android-build-server/
├── src/
│   ├── api/
│   │   └── server.mjs
│   ├── db/
│   │   └── database.mjs
│   └── worker/
│       └── index.mjs
├── jobs/
├── builds/
├── uploads/
├── data/
│   └── build-server.db
├── Dockerfile
└── package.json
```

This is still a prototype and should become a proper GitHub repository.

## GitHub Repository Goal

Suggested repository:

```text
android-build-server
```

Expected initial files:

```text
src/
Dockerfile
docker-compose.yml
package.json
package-lock.json
README.md
PROJECT-SCOPE.md
.env.example
.gitignore
```

Potential future directories:

```text
config/
scripts/
migrations/
tests/
docs/
```

Never commit:

```text
data/build-server.db
builds/
uploads/
.env
API keys
secrets
APK/AAB artifacts
logs
```

## Containerization Goal

Eventually the build server itself should run under Docker Compose.

There are two distinct container layers:

```text
Host
 |
 +-- Build Server application container
 |      |
 |      +-- API
 |      +-- queue
 |      +-- database access
 |
 +-- Android build containers
        |
        +-- Node
        +-- Java
        +-- Android SDK
        +-- Gradle
        +-- submitted project
```

Submitted builds must not run inside the same container as the API.

## Docker Compose Direction

Potential architecture:

```text
docker-compose.yml

services:

  api:
    build:
      context: .
    ...

  worker:
    build:
      context: .
    ...
```

Do not blindly containerize before deciding how the worker safely launches isolated build containers.

Possible approaches:

### Option A — Docker socket

API/worker container accesses the host Docker socket.

Simple, but `docker.sock` is highly privileged and creates a major security concern.

### Option B — Dedicated build runner

A separate build-runner service provides stronger isolation.

Preferred for the eventual hardened architecture.

### Option C — Host worker

API is containerized while the worker initially remains on the host.

Potential interim architecture.

## Recommended Containerization Approach

Initially preserve the proven architecture:

```text
Caddy
   |
   v
API container
   |
   v
Worker
   |
   v
isolated Android build container
```

The Docker runtime boundary must be explicitly documented and submitted source must not gain host-level Docker control.

## Web UI

The future web UI is API-driven:

```text
Browser
   |
   v
Web UI
   |
 HTTPS
   |
   v
Build API
   |
   +-- submit build
   +-- view status
   +-- view logs
   +-- list artifacts
   +-- download artifact
   +-- cancel build
```

The UI must not:

```text
run Gradle
access Docker
access SQLite directly
access build directories
```

## Future Web UI Features

### Dashboard

Statuses:

```text
queued
building
completed
failed
cancelled
```

### Submit Build

Fields:

```text
project name
source type
source URL/upload
Git ref
project root
platform
variant
artifact
environment variables
secrets
```

### Build Details

Show:

```text
build ID
project
status
submitted time
start time
completion time
duration
logs
artifacts
```

### Artifact

Show:

```text
filename
size
permanent download URL
```

### Authentication

Eventually support web UI user accounts/sessions.

Do not unnecessarily expose raw API keys to browser code.

## Future API Improvements

### Request Validation

Use a schema validator such as Zod or JSON Schema.

Validate:

```text
project
source
projectRoot
build
platform
variant
artifact
env
secrets
```

Reject malformed requests before queueing.

### Build Cancellation

Future:

```http
POST /api/v1/builds/:id/cancel
```

Must terminate:

- worker process
- Docker build container
- child processes

and set:

```text
cancelled
```

### Build Timeout

Every build should have a maximum duration.

Example:

```text
2 hours
```

Timeout should terminate the worker/container and mark the build failed with a clear reason.

### Artifact Metadata

Eventually store:

```text
artifacts
---------
id
build_id
filename
type
size
created_at
download_token
enabled
```

This is cleaner than scanning artifact directories.

### Cleanup / Retention

Need configurable retention for:

```text
completed builds
failed builds
artifacts
logs
```

Permanent URLs must stop working if their artifact is deleted. Token records can remain but should be disabled as appropriate.

## Logging

Current log:

```text
builds/<build-id>/logs/build.log
```

Logs stream from Docker.

Secrets must never appear in logs.

Future:

- structured logging
- log pagination
- WebSocket/SSE log streaming
- build phases
- retention

## API Key Management

Future:

```text
create
list
disable
revoke
rotate
```

Each key should have:

```text
name
created_at
last_used_at
enabled
scopes
```

Plaintext key is shown only once.

## Multi-Tenant Direction

Eventually support multiple clients.

Every build should be associated with its API-key/client identity:

```text
Client
 |
 +-- API key
      |
      +-- builds
      +-- artifacts
      +-- logs
```

Clients must not access other clients' builds unless explicitly authorized.

## Public Download Security

Permanent URLs are bearer credentials:

```text
Anyone with the URL can download the artifact.
```

This is intentional.

Requirements:

- unguessable tokens
- revocation
- authenticated artifact listing
- avoid exposing tokens in logs
- consider access logging
- deleting an artifact invalidates its URL

## SSRF / Network Security

Assume submitted projects are hostile.

Potential attack paths:

```text
malicious package.json
malicious postinstall
malicious Gradle task
malicious Git repository
malicious ZIP
malicious dependency
```

Builds need:

```text
container isolation
resource limits
network restrictions
filesystem isolation
non-root execution
```

## Supply Chain Security

The build environment downloads:

- Node
- Java
- Android SDK
- npm dependencies
- Gradle dependencies

Future improvements:

- pin versions
- checksums where practical
- controlled base images
- image vulnerability scanning
- regular rebuilds
- dependency caching
- reproducibility

The base toolchain should remain controlled without unnecessarily preventing projects from using compatible dependency versions.

## Current Known Limitations

1. Persistent queue/recovery
2. Build cancellation
3. Build timeout
4. API scopes
5. API-key management
6. Artifact metadata table
7. Artifact token revocation
8. Upload API
9. Public Git SSRF protection
10. ZIP symlink protection
11. Build-container network restrictions
12. Final Docker runtime isolation strategy
13. Retention/cleanup
14. Multi-client authorization boundaries
15. Structured logging
16. Web UI
17. Production monitoring
18. Automated tests
19. CI/CD for the build server

## Current Proven Functionality

Successfully tested:

- Android build image creation
- Android SDK in container
- Node.js in container
- Java in container
- Expo prebuild
- Gradle Android build
- APK generation
- AAB support in worker
- directory source
- ZIP source
- Git source
- monorepo `projectRoot`
- arbitrary environment variables
- secret injection
- secret masking
- isolated Docker builds
- CPU/memory/PID limits
- API server
- SQLite
- API-key authentication
- authenticated build submission
- authenticated build status
- authenticated artifact listing
- authenticated artifact download
- permanent artifact download tokens
- stable artifact URL
- public artifact download
- Caddy reverse proxy
- HTTPS
- public DNS
- full public download URL
- real Clocker release build through generic build system

## Important Design Principle

The build server must remain project-agnostic.

Do NOT add:

```text
if project === "clocker"
```

or hard-coded:

```text
ANDROID_GOOGLE_MAPS_API_KEY
EXPO_PUBLIC_API_URL
```

logic.

Clocker configuration is supplied by the client.

The server's responsibility is:

```text
receive source
receive build configuration
receive environment
receive secrets
build
store artifact
report result
```

## Suggested Future Repository Structure

```text
android-build-server/
├── src/
│   ├── api/
│   │   ├── server.mjs
│   │   ├── middleware/
│   │   └── routes/
│   ├── db/
│   │   ├── database.mjs
│   │   └── migrations/
│   ├── queue/
│   │   ├── queue.mjs
│   │   └── recovery.mjs
│   ├── worker/
│   │   ├── index.mjs
│   │   ├── docker.mjs
│   │   ├── source.mjs
│   │   └── artifacts.mjs
│   └── security/
├── scripts/
├── tests/
├── docs/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── README.md
└── PROJECT-SCOPE.md
```

## Immediate Next Task

After importing into Claude Code:

### Implement persistent build queue/recovery.

Requirements:

1. SQLite remains source of truth.
2. Queued builds survive API restart.
3. Reconstruct queued builds at API startup.
4. Safely handle builds that were `building` when API stopped.
5. Never run duplicate builds.
6. Preserve API behavior.
7. Preserve permanent artifact URLs.
8. Preserve API-key authentication.
9. Preserve `PUBLIC_BASE_URL`.
10. Do not persist secrets.
11. Add restart/recovery tests.
12. Do not add Clocker-specific logic.

Then proceed through the remaining security/reliability work before the web UI.

## Development Philosophy

Favor:

- simple components
- explicit interfaces
- strong isolation
- persistent state
- clear logging
- API-first architecture
- reproducible builds
- project-agnostic behavior
- incremental implementation
- testable components

Avoid premature complexity.

The current system works end-to-end and should be evolved carefully rather than rewritten without preserving proven behavior.

## Claude Code Handoff Instructions

1. Read this document completely.
2. Inspect the existing source before modifying anything.
3. Verify the implementation against this document rather than assuming it is exact.
4. Preserve working behavior.
5. Do not add Clocker-specific build logic.
6. Never expose secrets in output.
7. Do not expose Docker to submitted code unnecessarily.
8. Do not make port 8080 Internet-accessible.
9. Preserve Caddy as the external TLS/reverse-proxy layer.
10. Preserve `builds.haymondtechnologies.com`.
11. Preserve full artifact URLs using `PUBLIC_BASE_URL`.
12. Treat permanent download URLs as bearer credentials.
13. Add tests before major architectural changes.
14. Prefer small incremental changes.
15. Document security assumptions.
16. Keep the web UI API-driven.
17. Containerize the service only after explicitly considering Docker runtime/isolation implications.

The immediate objective is to turn the proven prototype into a maintainable GitHub project and progressively harden it into a production-capable generic Android build service.
