# Caddy setup (API + web UI)

This project needs **two** public routes if you're running the web UI at
all: one for the API, one for the static dashboard. **Both are served
from the build-server host itself** — the public-facing Caddy (on a
separate host, terminating TLS) only ever `reverse_proxy`s to this host,
for both routes, the same way. It never serves files directly and never
needs a copy of `web/` on its own disk.

```text
Public Caddy (separate host, terminates TLS)
   |
   +-- builds-api.<domain>  --> reverse_proxy --> build-server host:PORT      (the api service)
   |
   +-- builds.<domain>      --> reverse_proxy --> build-server host:WEB_PORT  (the web service)
```

Setting up the public Caddy is a manual, system-level step this repo
doesn't own — nothing here is automated by `scripts/setup.mjs` or
`scripts/update.sh`.

## Naming convention

Every example in this project's docs uses:

- **`builds.<domain>`** — the web UI (the primary, memorable address —
  what a person actually types or bookmarks).
- **`builds-api.<domain>`** — the API (a distinguishing subdomain — what
  the web UI, CI systems, and any other API client talk to).

You don't have to follow this exact pattern, but `PUBLIC_BASE_URL` (in
`.env`) and `WEB_UI_ORIGIN` (also in `.env`) need to match whatever
hostnames you actually choose, exactly — scheme, host, no trailing slash.

## The `web` Compose service

`docker-compose.yml` has a `web` service — a small Caddy container, on
the **build-server host**, that does nothing but serve `web/` locally on
`WEB_PORT` (default `8081`) with one important header set (see "Why a
Cache-Control header matters" below). It's opt-in (Compose profile
`web`), since the web UI is optional:

```bash
docker compose --profile web up -d --build
```

`scripts/setup.mjs` prompts for this (`Deploy the web UI too?`) and picks
`WEB_PORT` the same conflict-checked way it picks the API's `PORT`.

Because it's a bind mount (`./web:/srv/web:ro` in `docker-compose.yml`),
**there's no separate deploy step for web UI changes** — `git
pull`/`scripts/update.sh` updates the files on disk, and the running
`web` container picks them up immediately, no rebuild or restart needed.
Nothing to copy anywhere, unlike an earlier version of this doc that had
you rsyncing `web/` to the proxy host separately — don't do that; the
proxy host should only ever reverse_proxy here.

## Prerequisites

- **Caddy installed** on the proxy host. The official install
  instructions (`https://caddyserver.com/docs/install`) set it up as a
  systemd service on Debian/Ubuntu, which the rest of this doc assumes —
  `sudo systemctl {status,reload,restart} caddy`, config at
  `/etc/caddy/Caddyfile`.
- **DNS**: an A (and/or AAAA) record for *each* hostname pointing at the
  proxy host's public IP. Caddy provisions and renews HTTPS certificates
  automatically (Let's Encrypt) the moment it sees a hostname in a site
  block — no manual certbot step, no cron job — but only once DNS
  actually resolves and ports 80/443 are reachable from the internet for
  the ACME challenge. Freshly-changed DNS can take a few minutes to
  propagate; Caddy will retry.
- **Firewall**: 80 and 443 open to the world **on the proxy host only**.
  The build-server host must never expose `PORT` or `WEB_PORT` to the
  world — only reachable from the proxy host's specific LAN IP:
  ```bash
  sudo ufw allow from 10.x.x.x to any port 8080 proto tcp   # PORT
  sudo ufw allow from 10.x.x.x to any port 8081 proto tcp   # WEB_PORT
  ```
  (`10.x.x.x` = the proxy host's LAN IP.) This is the one intentional
  exception to "nothing internal is Internet-facing": the proxy host *is*
  the Internet-facing thing, by design.

## Full example Caddyfile

Both site blocks, as they'd sit together in `/etc/caddy/Caddyfile` on the
**proxy host**:

```caddyfile
# --- API ---
builds-api.example.com {
    encode zstd gzip

    reverse_proxy 10.x.x.x:8080 {
        # Caddy keeps proxying even if a health check fails — this just
        # controls how it detects a genuinely dead backend faster than
        # waiting for a real request to time out.
        health_uri /health
        health_interval 30s
        health_timeout 5s
    }

    log {
        output file /var/log/caddy/builds-api-access.log {
            roll_size 50mb
            roll_keep 5
        }
    }
}

# --- Web UI ---
builds.example.com {
    encode zstd gzip

    reverse_proxy 10.x.x.x:8081

    log {
        output file /var/log/caddy/builds-access.log {
            roll_size 50mb
            roll_keep 5
        }
    }
}
```

Replace `10.x.x.x` with the **build-server host's** LAN IP (the same host
for both blocks), `8080`/`8081` with whatever `PORT`/`WEB_PORT` you
chose. Notice both blocks are the same shape — `reverse_proxy` to the
build-server host — there's no `file_server`/`root` directive anywhere in
this Caddyfile at all; that's the `web` Compose service's job, over on
the build-server host.

This gets you: automatic HTTPS for both hostnames, gzip/zstd compression,
access logs with automatic rotation, and a lightweight health check on
the API's reverse proxy. Nothing here needs an
`Access-Control-Allow-Origin` header or any other CORS configuration at
the Caddy layer — **the API already handles CORS itself** via
`WEB_UI_ORIGIN` (see `deployment.md`). Don't add a wildcard CORS header
in Caddy on top of that; it would only weaken what the API already gets
right.

The automatic HTTPS here isn't just nice-to-have: signing into the web
UI sets a `SameSite=None` session cookie (real HTTP auth, separate from
API keys) so it can be sent across these two hostnames, and every
browser refuses to store a `SameSite=None` cookie that isn't also
`Secure` — confirmed directly against a real browser session, which
silently dropped the cookie entirely the one time this was tried without
HTTPS. Skip this Caddy setup (e.g. testing directly against `PORT`/
`WEB_PORT` over plain `http://`) and sign-in will appear to succeed but
never actually stick — see `deployment.md`'s Troubleshooting section.

## Why a Cache-Control header matters here

`web/` is hand-authored with no build step and no versioned/hashed
filenames (see `README.md`'s design goals). A browser that aggressively
caches `app.js` could keep running old code against a new API after an
update, silently. The `web` Compose service's `Caddyfile.web` sets
`Cache-Control: no-cache` on everything it serves — forcing a cheap
revalidation request every load instead of trusting a stale copy. For a
handful of small files this costs nothing noticeable. This is already
built in; nothing you need to configure on the proxy host.

## Validating and applying config changes

Never blindly restart Caddy on a config change — validate first, then
reload (which is zero-downtime; Caddy hot-swaps its config):

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Check it actually picked up the change and is healthy:

```bash
sudo systemctl status caddy
sudo journalctl -u caddy -f          # tail Caddy's own logs
```

## Verifying end-to-end

```bash
curl -sI https://builds-api.example.com/health   # expect HTTP/2 200
curl -sI https://builds.example.com/             # expect HTTP/2 200
```

Then open `https://builds.example.com` in a real browser and sign in —
this exercises the actual CORS path (`WEB_UI_ORIGIN` must match this
exact origin) end to end, which `curl` alone won't catch.

## Security considerations specific to each route

- **API route**: this is the one other systems (CI, other services, the
  web UI) need to reach — it's meant to be reachable from wherever your
  API clients actually are. Rate limiting isn't configured here since
  authentication is a 256-bit bearer token, not a password — brute-forcing
  a valid key isn't a realistic concern the way it would be for a login
  form.
- **Web UI route**: think about who this dashboard is actually for before
  leaving it fully public. Everything on it is already gated by API key
  sign-in, but if it's only meant for a small internal team, consider
  restricting it further at the proxy layer — e.g. by source IP:

  ```caddyfile
  builds.example.com {
      @blocked not remote_ip 203.0.113.0/24 10.0.0.0/8
      respond @blocked 403

      reverse_proxy 10.x.x.x:8081
  }
  ```

  or by adding HTTP Basic Auth as a second factor in front of the whole
  site (`basicauth` directive) — genuinely optional, since the app itself
  already requires a real API key for anything to work; this is
  defense-in-depth, not a substitute.
- Never put `Access-Control-Allow-Origin: *` (or any CORS header at all)
  on the API's Caddy block — see above.

## Alternative: everything on one host

If you're not running a separate proxy host at all — the proxy itself
also runs in Docker, on the *same* host as `build-server` — it can join
the same Compose network and reach both services by their service names
instead of a LAN IP, which is simpler and needs no firewall rule between
them at all (Compose's internal network handles that):

```yaml
# docker-compose.override.yml (or add this service to docker-compose.yml directly)
services:
  proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile.proxy:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

```caddyfile
# ./Caddyfile.proxy — same shape as the two-host version, just pointed at
# Compose service names instead of a LAN IP
builds-api.example.com {
    reverse_proxy api:8080
}

builds.example.com {
    reverse_proxy web:80
}
```

`docker compose --profile web up -d` (this needs the `web` profile too,
alongside whatever profile/flag brings up this `proxy` service) picks
this up. The `caddy_data` volume is what persists issued certificates
across restarts — don't delete it casually, or Caddy will need to
re-provision from Let's Encrypt (which is rate-limited).

## Troubleshooting

**Certificate issuance fails / site hangs on load** — almost always DNS
hasn't propagated yet, or port 80/443 isn't actually reachable from the
public internet (check from an external network, not the LAN — a router
NAT rule or a cloud security group is a common culprit). `journalctl -u
caddy -f` shows the actual ACME error. Let's Encrypt also rate-limits
repeated failures for the same hostname — space out retries if you're
debugging a DNS issue rather than hammering it.

**502 Bad Gateway on either route** — the proxy can't reach
`10.x.x.x:PORT` or `10.x.x.x:WEB_PORT`. Check the build-server host is
actually up (`curl http://10.x.x.x:PORT/health` and `curl
http://10.x.x.x:WEB_PORT/` from the proxy host itself), check the
firewall rule on the build-server host explicitly allows the proxy
host's IP for *both* ports, and check the port numbers in the Caddyfile
match what's actually in `.env`. If it's the web UI route specifically,
also confirm the `web` service is actually running:
`docker compose ps` should show `build-server-web-1` as `Up` — it's
opt-in (`--profile web`), so a plain `docker compose up -d` on its own
won't start it.

**The web UI loads fine but breaks/404s after clicking around and
refreshing** — shouldn't happen with this app specifically: it's a
hash-routed SPA (`#/builds/...`, `#/admin`, etc.), and everything after
the `#` never reaches the server at all, even on a hard refresh. If you
*are* seeing something like this, check the `web` service's own logs
(`docker compose logs web`) rather than the proxy — the proxy is just
forwarding requests, not serving files.

**Browser console shows a CORS error even though the proxy looks fine** —
this is almost never a Caddy problem; see `deployment.md`'s
Troubleshooting section for `WEB_UI_ORIGIN` (it has to match the web
UI's origin exactly, and the API needs restarting after changing it).

**Stale JavaScript after an update** (a build submission behaves like an
older version of the app) — check the `web` service actually picked up
the file change (`docker compose logs web`, or just `curl` the file
directly against `WEB_PORT` and diff it against what's in `git`); since
it's a live bind mount this should be immediate, so a mismatch usually
means the update didn't actually reach this host (check `git log` there)
rather than a caching problem.
