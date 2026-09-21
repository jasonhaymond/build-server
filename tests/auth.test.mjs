import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { createRecoveryCodes, getUserById, updateUserPassword } from "../src/db/database.mjs";
import { createTestSession, createTestUser, createTestUserWithTotp, currentTotpCode } from "./helpers.mjs";
import { hashPassword } from "../src/security/passwords.mjs";
import { generateRecoveryCodes, hashRecoveryCode } from "../src/security/totp.mjs";

const REAL_PASSWORD = "a-real-password-123";

function withRealPassword(role) {
  const user = createTestUserWithTotp({ role });
  updateUserPassword(user.id, hashPassword(REAL_PASSWORD));
  return user;
}

describe("POST /api/v1/auth/login", () => {
  it("rejects an unknown username", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "nobody-at-all", password: "whatever" });

    expect(res.status).toBe(401);
  });

  it("rejects the wrong password", async () => {
    const user = withRealPassword("user");
    const dbUser = getUserById(user.id);

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("returns an mfaToken for a correct password on a fully-enrolled account", async () => {
    const user = withRealPassword("user");
    const dbUser = getUserById(user.id);

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: REAL_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.mfaToken).toBeTruthy();
    expect(res.body.needsEnrollment).toBeFalsy();
  });

  it("routes a not-yet-enrolled account straight into enrollment instead", async () => {
    const user = createTestUser({ role: "admin" });
    updateUserPassword(user.id, hashPassword(REAL_PASSWORD));
    const dbUser = getUserById(user.id);

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: REAL_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.needsEnrollment).toBe(true);
    expect(res.body.enrollmentToken).toBeTruthy();
  });
});

describe("POST /api/v1/auth/login/mfa", () => {
  it("completes login with a valid TOTP code and sets a session cookie", async () => {
    const user = withRealPassword("user");
    const dbUser = getUserById(user.id);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: REAL_PASSWORD });

    const mfa = await request(app)
      .post("/api/v1/auth/login/mfa")
      .send({ mfaToken: login.body.mfaToken, code: currentTotpCode(user.secret) });

    expect(mfa.status).toBe(200);
    expect(mfa.body.csrfToken).toBeTruthy();
    expect(mfa.body.user.username).toBe(dbUser.username);
    expect(mfa.headers["set-cookie"]?.[0]).toContain("bs_session=");

    const cookie = mfa.headers["set-cookie"][0].split(";")[0];
    const whoami = await request(app).get("/api/v1/whoami").set("Cookie", cookie);
    expect(whoami.status).toBe(200);
    expect(whoami.body.authMethod).toBe("session");
  });

  it("rejects a wrong code", async () => {
    const user = withRealPassword("user");
    const dbUser = getUserById(user.id);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: REAL_PASSWORD });

    const mfa = await request(app)
      .post("/api/v1/auth/login/mfa")
      .send({ mfaToken: login.body.mfaToken, code: "000000" });

    expect(mfa.status).toBe(401);
  });

  it("rejects an unknown/expired mfaToken", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login/mfa")
      .send({ mfaToken: "not-a-real-token", code: "123456" });

    expect(res.status).toBe(410);
  });
});

describe("session auth on protected routes", () => {
  it("accepts a valid session cookie", async () => {
    const { cookie } = createTestSession({ role: "user" });
    const res = await request(app).get("/api/v1/builds").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("rejects requests with no cookie and no Authorization header", async () => {
    const res = await request(app).get("/api/v1/builds");
    expect(res.status).toBe(401);
  });

  it("rejects a mutating request with no CSRF header", async () => {
    const { cookie } = createTestSession({ role: "user" });
    const res = await request(app).post("/api/v1/api-keys").set("Cookie", cookie).send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/);
  });

  it("rejects a mutating request with the wrong CSRF token", async () => {
    const { cookie } = createTestSession({ role: "user" });
    const res = await request(app)
      .post("/api/v1/api-keys")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", "wrong-token")
      .send({ name: "x" });
    expect(res.status).toBe(403);
  });

  it("accepts a mutating request with the correct CSRF token", async () => {
    const { cookie, csrfToken } = createTestSession({ role: "user" });
    const res = await request(app)
      .post("/api/v1/api-keys")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ name: "my-key" });
    expect(res.status).toBe(201);
  });

  it("does not require CSRF for GET requests", async () => {
    const { cookie } = createTestSession({ role: "user" });
    const res = await request(app).get("/api/v1/api-keys").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("clears the session so the old cookie no longer works", async () => {
    const { cookie, csrfToken } = createTestSession({ role: "user" });

    const before = await request(app).get("/api/v1/whoami").set("Cookie", cookie);
    expect(before.status).toBe(200);

    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);
    expect(logout.status).toBe(204);

    const after = await request(app).get("/api/v1/whoami").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });
});

describe("recovery codes", () => {
  it("logging in with a valid recovery code works, and consumes it", async () => {
    const user = withRealPassword("user");
    const dbUser = getUserById(user.id);

    const codes = generateRecoveryCodes(1);
    createRecoveryCodes(user.id, codes.map(hashRecoveryCode), new Date().toISOString());

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: REAL_PASSWORD });

    const mfa = await request(app)
      .post("/api/v1/auth/login/mfa")
      .send({ mfaToken: login.body.mfaToken, code: codes[0] });

    expect(mfa.status).toBe(200);

    // Same code, a fresh login attempt — must already be consumed.
    const login2 = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: dbUser.username, password: REAL_PASSWORD });

    const mfa2 = await request(app)
      .post("/api/v1/auth/login/mfa")
      .send({ mfaToken: login2.body.mfaToken, code: codes[0] });

    expect(mfa2.status).toBe(401);
  });
});
