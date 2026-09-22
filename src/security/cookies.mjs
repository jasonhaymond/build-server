// Hand-rolled cookie parsing/building — the web UI and API only ever need
// to read and set exactly one cookie, so a full `cookie-parser`
// dependency isn't worth adding for this.
export const SESSION_COOKIE_NAME = "bs_session";

export function parseCookieHeader(header) {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        const name = index === -1 ? part : part.slice(0, index);
        const value = index === -1 ? "" : part.slice(index + 1);
        return [decodeURIComponent(name), decodeURIComponent(value)];
      }),
  );
}

// SameSite=None because production runs the web UI and API on different
// subdomains (docs/caddy-setup.md) — a cross-site context by the cookie
// spec's definition even though both are under the same operator's
// control. Browsers *require* Secure on any SameSite=None cookie and
// silently drop it otherwise (confirmed directly: a real Chromium
// session never stored the cookie at all when this sent SameSite=None
// without Secure) — so SameSite has to track `secure`, not be hardcoded.
// COOKIE_SECURE=false (local non-HTTPS dev) therefore also means
// same-origin-only cookies (Lax); genuine cross-origin dev needs either
// real HTTPS or a same-origin setup, the same as production does.
function sameSiteFor(secure) {
  return secure ? "SameSite=None" : "SameSite=Lax";
}

export function buildSessionCookie(token, { secure, maxAgeSeconds }) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    sameSiteFor(secure),
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function buildClearedSessionCookie({ secure }) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    sameSiteFor(secure),
    "Max-Age=0",
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
