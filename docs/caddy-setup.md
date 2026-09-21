# Caddy setup (API + web UI)

This project needs **two** public routes if you're running the web UI at
all: one for the API, one for the static dashboard. This doc covers both,
on the assumption that they're served by Caddy — the default reverse
proxy for this project — on a **separate host** from the one running
`build-server` itself (the architecture this project is built around; see
`deployment.md`'s Architecture recap). A single-host alternative (Caddy in
Docker, alongside the API container) is covered near the end.

Setting up Caddy is a manual, system-level step this repo doesn't own —
nothing here is automated by `scripts/setup.mjs` or `scripts/update.sh`.

## Naming convention

Every example in this project's docs uses:

- **`builds.<domain>`** — the web UI (the primary, memorable address —
  what a person actually types or bookmarks).
- **`builds-api.<domain>`** — the API (a distinguishing subdomain — what
  the web UI, CI systems, and any other API client talk to).

You don't have to follow this exact pattern, but `PUBLIC_BASE_URL` (in
the API's `.env`) and `WEB_UI_ORIGIN` (also in `.env`) need to match
whatever hostnames you actually choose, exactly — scheme, host, no
trailing slash.

## Prerequisites

- **Caddy installed** on the proxy host. The official install
  instructions (`https://caddyserver.com/docs/install`) set it up as a
  systemd service on Debian/Ubuntu, which the rest of this doc assumes —
  `sudo systemctl {status,reload,restart} caddy`, config at
  `/etc/caddy/Caddyfile`.
- **DNS**: an A (and/or AAAA) record for *each* hostname pointing at the
  Caddy host's public IP. Caddy provisions and renews HTTPS certificates
  automatically (Let's Encrypt) the moment it sees a hostname in a site
  block — no manual certbot step, no cron job — but only once DNS
  actually resolves and ports 80/443 are reachable from the internet for
  the ACME challenge. Freshly-changed DNS can take a few minutes to
  propagate; Caddy will retry.
- **Firewall**: 80 and 443 open to the world **on the Caddy host only**.
  The build-server host's `PORT` must never be open to the world — only
  reachable from the Caddy host's specific LAN IP (see `deployment.md`'s
  Prerequisites section for the exact `ufw` rule). This is the one
  intentional exception to "nothing internal is Internet-facing": Caddy
  *is* the Internet-facing thing, by design.

## Full example Caddyfile

Both site blocks, as they'd sit together in `/etc/caddy/Caddyfile`:

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

    root * /path/to/build-server/web
    file_server

    # This is a hand-authored static site with no build step and no
    # versioned/hashed filenames (see the project's own design goal in
    # README.md) — a stale cached app.js after an update would silently
    # run old code against a new API. no-cache forces a cheap revalidation
    # request every load instead of serving a stale copy; for a handful of
    # small files this costs nothing noticeable.
    header Cache-Control "no-cache"

    log {
        output file /var/log/caddy/builds-access.log {
            roll_size 50mb
            roll_keep 5
        }
    }
}
```

Replace `10.x.x.x` with the build-server host's LAN IP, `8080` with
whatever `PORT` you chose, and `/path/to/build-server/web` with this
repo's actual `web/` directory on the Caddy host (see "Getting `web/`
onto the Caddy host" below — it needs to physically exist there, since
`file_server` serves local files, not something Caddy can fetch remotely).

Both blocks together get you: automatic HTTPS for both hostnames,
gzip/zstd compression, access logs with automatic rotation, and a
lightweight health check on the API's reverse proxy. Nothing here needs
an `Access-Control-Allow-Origin` header or any other CORS configuration
at the Caddy layer — **the API already handles CORS itself** via
`WEB_UI_ORIGIN` (see `deployment.md`). Don't add a wildcard CORS header
in Caddy on top of that; it would only weaken what the API already gets
right.

## Getting `web/` onto the Caddy host

`file_server` serves files that exist on the Caddy host's own disk. Since
this is a separate host from the one running `build-server`, `web/`
needs to be copied there — there's no build step, so this is just the
directory as-is:

```bash
# From the build-server host, or wherever you cloned the repo:
rsync -av web/ user@caddy-host:/path/to/build-server/web/
```

**Re-run this after every update that touches `web/`** — it's not part
of `scripts/update.sh` (that script only knows about the build-server
host), and Caddy will otherwise keep serving whatever's already on disk.
If you'd rather not think about this, an alternative is cloning this
repo directly onto the Caddy host too (`git pull` there alongside
whatever you run on the build-server host) and pointing `root *` at that
clone's `web/` directory — nothing else from the repo needs to be present
on the Caddy host, only `web/`.

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
  restricting it further at the Caddy layer — e.g. by source IP:

  ```caddyfile
  builds.example.com {
      @blocked not remote_ip 203.0.113.0/24 10.0.0.0/8
      respond @blocked 403

      root * /path/to/build-server/web
      file_server
  }
  ```

  or by adding HTTP Basic Auth as a second factor in front of the whole
  site (`basicauth` directive) — genuinely optional, since the app itself
  already requires a real API key for anything to work; this is
  defense-in-depth, not a substitute.
- Never put `Access-Control-Allow-Origin: *` (or any CORS header at all)
  on the API's Caddy block — see above.

## Alternative: Caddy in Docker, same host as the API

If you're not running a separate proxy host — a single-host deployment —
Caddy can run as its own container alongside the `api` service, sharing
Docker Compose's network so it can reach the API by service name instead
of a LAN IP:

```yaml
# docker-compose.override.yml (or add a service to docker-compose.yml directly)
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./web:/srv/web:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

```caddyfile
# ./Caddyfile — note reverse_proxy targets the compose service name, not a LAN IP
builds-api.example.com {
    reverse_proxy api:8080
}

builds.example.com {
    root * /srv/web
    file_server
    header Cache-Control "no-cache"
}
```

`docker compose up -d` picks this up alongside the `api` service. The
`caddy_data` volume is what persists issued certificates across restarts
— don't delete it casually, or Caddy will need to re-provision from
Let's Encrypt (which is rate-limited).

## Troubleshooting

**Certificate issuance fails / site hangs on load** — almost always DNS
hasn't propagated yet, or port 80/443 isn't actually reachable from the
public internet (check from an external network, not the LAN — a router
NAT rule or a cloud security group is a common culprit). `journalctl -u
caddy -f` shows the actual ACME error. Let's Encrypt also rate-limits
repeated failures for the same hostname — space out retries if you're
debugging a DNS issue rather than hammering it.

**502 Bad Gateway on the API route** — Caddy can't reach
`10.x.x.x:PORT`. Check the build-server host is actually up
(`curl http://10.x.x.x:PORT/health` from the Caddy host itself), check
the firewall rule on the build-server host explicitly allows the Caddy
host's IP, and check `PORT` in the Caddyfile matches what's actually in
`.env`.

**The web UI loads fine but breaks/404s after clicking around and
refreshing** — shouldn't happen with this app specifically: it's a
hash-routed SPA (`#/builds/...`, `#/admin`, etc.), and everything after
the `#` never reaches the server at all, even on a hard refresh. If you
*are* seeing this, it means `file_server` isn't finding `index.html` at
all — check `root *` actually points at the directory containing
`index.html`, not its parent.

**Browser console shows a CORS error even though Caddy looks fine** —
this is almost never a Caddy problem; see `deployment.md`'s
Troubleshooting section for `WEB_UI_ORIGIN` (it has to match the web
UI's origin exactly, and the API needs restarting after changing it).

**Stale JavaScript after an update** (a build submission behaves like an
older version of the app) — either the `Cache-Control: no-cache` header
above got dropped from the Caddyfile, or `web/` wasn't re-copied to the
Caddy host after the update (see "Getting `web/` onto the Caddy host").
