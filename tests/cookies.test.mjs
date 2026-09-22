import { describe, expect, it } from "vitest";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
} from "../src/security/cookies.mjs";

describe("parseCookieHeader", () => {
  it("parses multiple cookies", () => {
    expect(parseCookieHeader("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns an empty object for a missing header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("decodes URI-encoded values", () => {
    expect(parseCookieHeader("token=a%2Fb%3Dc")).toEqual({ token: "a/b=c" });
  });
});

describe("buildSessionCookie / buildClearedSessionCookie", () => {
  it("round-trips a token through build and parse", () => {
    const cookie = buildSessionCookie("some-token-value", { secure: true, maxAgeSeconds: 3600 });
    const [pair] = cookie.split(";");
    const parsed = parseCookieHeader(pair);
    expect(parsed[SESSION_COOKIE_NAME]).toBe("some-token-value");
  });

  it("includes Secure only when requested", () => {
    expect(buildSessionCookie("t", { secure: true, maxAgeSeconds: 60 })).toContain("Secure");
    expect(buildSessionCookie("t", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
  });

  it("always sets HttpOnly, and SameSite=None when secure", () => {
    const cookie = buildSessionCookie("t", { secure: true, maxAgeSeconds: 60 });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=None");
  });

  // Browsers require Secure on any SameSite=None cookie and silently
  // drop it otherwise — confirmed directly against a real Chromium
  // session, which never stored the cookie at all when this sent
  // SameSite=None without Secure. SameSite has to track `secure`.
  it("falls back to SameSite=Lax when not secure, instead of a cookie browsers would just drop", () => {
    const cookie = buildSessionCookie("t", { secure: false, maxAgeSeconds: 60 });
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=None");
  });

  it("clears the cookie with Max-Age=0", () => {
    expect(buildClearedSessionCookie({ secure: true })).toContain("Max-Age=0");
  });
});
