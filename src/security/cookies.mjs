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

// SameSite=None (not Lax/Strict) because the web UI and API are meant to
// run on different subdomains (docs/caddy-setup.md) — a cross-site
// context by the cookie spec's definition even though both are under the
// same operator's control. `secure` is a parameter (not hardcoded true)
// so local non-HTTPS dev can turn it off via COOKIE_SECURE=false.
export function buildSessionCookie(token, { secure, maxAgeSeconds }) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
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
    "SameSite=None",
    "Max-Age=0",
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
