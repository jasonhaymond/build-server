import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { createSession, getUserById, updateUserPassword, enableUserTotp } from "../src/db/database.mjs";
import { SESSION_COOKIE_NAME } from "../src/security/cookies.mjs";
import { hashPassword, verifyPassword } from "../src/security/passwords.mjs";
import { generateTotpSecret } from "../src/security/totp.mjs";
import { createTestApiKey, createTestSession, createTestUserWithTotp } from "./helpers.mjs";

const KNOWN_PASSWORD = "old-real-password-1";

function sessionWithKnownPassword({ role = "user", totp = false } = {}) {
  const session = createTestSession({ role });
  updateUserPassword(session.userId, hashPassword(KNOWN_PASSWORD));

  if (totp) {
    enableUserTotp(session.userId, generateTotpSecret());
  }

  return session;
}

describe("POST /api/v1/me/password", () => {
  it("requires session auth (not an API key)", async () => {
    const key = createTestApiKey();
    const res = await request(app)
      .post("/api/v1/me/password")
      .set("Authorization", `Bearer ${key}`)
      .send({ currentPassword: "x", newPassword: "a-real-password-123" });

    expect(res.status).toBe(403);
  });

  it("changes the password when the current one is correct", async () => {
    const { cookie, csrfToken, userId } = sessionWithKnownPassword();

    const res = await request(app)
      .post("/api/v1/me/password")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: KNOWN_PASSWORD, newPassword: "new-real-password-2" });

    expect(res.status).toBe(200);
    expect(verifyPassword("new-real-password-2", getUserById(userId).passwordHash)).toBe(true);
  });

  it("rejects the wrong current password", async () => {
    const { cookie, csrfToken } = sessionWithKnownPassword();

    const res = await request(app)
      .post("/api/v1/me/password")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: "totally-wrong", newPassword: "new-real-password-2" });

    expect(res.status).toBe(401);
  });

  it("rejects a too-short new password", async () => {
    const { cookie, csrfToken } = sessionWithKnownPassword();

    const res = await request(app)
      .post("/api/v1/me/password")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: KNOWN_PASSWORD, newPassword: "short" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/me/recovery-codes", () => {
  it("regenerates recovery codes when the current password is correct", async () => {
    const { cookie, csrfToken } = sessionWithKnownPassword({ totp: true });

    const res = await request(app)
      .post("/api/v1/me/recovery-codes")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: KNOWN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(8);
  });

  it("refuses when TOTP isn't enrolled", async () => {
    const { cookie, csrfToken } = sessionWithKnownPassword({ totp: false });

    const res = await request(app)
      .post("/api/v1/me/recovery-codes")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: KNOWN_PASSWORD });

    expect(res.status).toBe(409);
  });

  it("rejects the wrong current password", async () => {
    const user = createTestUserWithTotp({ role: "user" });
    updateUserPassword(user.id, hashPassword(KNOWN_PASSWORD));

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const csrfToken = randomBytes(32).toString("hex");

    createSession({
      tokenHash,
      userId: user.id,
      csrfToken,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const res = await request(app)
      .post("/api/v1/me/recovery-codes")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${rawToken}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: "wrong" });

    expect(res.status).toBe(401);
  });
});
