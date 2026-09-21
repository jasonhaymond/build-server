import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { getUserById, getUserByUsername, listSignupRequests } from "../src/db/database.mjs";
import { verifyPassword } from "../src/security/passwords.mjs";
import { createTestInvite, createTestUserWithTotp, currentTotpCode } from "./helpers.mjs";

describe("GET /api/v1/auth/invites/:token", () => {
  it("returns the invite's purpose/role/suggestedUsername", async () => {
    const token = createTestInvite({ purpose: "signup", role: "admin", suggestedUsername: "newadmin" });
    const res = await request(app).get(`/api/v1/auth/invites/${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ purpose: "signup", role: "admin", suggestedUsername: "newadmin" });
  });

  it("404s for an unknown token", async () => {
    const res = await request(app).get("/api/v1/auth/invites/not-a-real-token");
    expect(res.status).toBe(404);
  });

  it("404s for an expired token", async () => {
    const token = createTestInvite({ expiresInMs: -1000 });
    const res = await request(app).get(`/api/v1/auth/invites/${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/auth/invites/:token/complete — signup", () => {
  it("creates the account and returns an enrollmentToken, not a session", async () => {
    const token = createTestInvite({ purpose: "signup", role: "user", suggestedUsername: "brand-new-user" });

    const res = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "a-real-password-123" });

    expect(res.status).toBe(201);
    expect(res.body.enrollmentToken).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeUndefined();

    const created = getUserByUsername("brand-new-user");
    expect(created).toBeTruthy();
    expect(created.role).toBe("user");
    expect(created.totpEnabled).toBe(0);
    expect(verifyPassword("a-real-password-123", created.passwordHash)).toBe(true);
  });

  it("can't be redeemed twice", async () => {
    const token = createTestInvite({ purpose: "signup", suggestedUsername: "once-only-user" });

    await request(app).post(`/api/v1/auth/invites/${token}/complete`).send({ password: "a-real-password-123" });
    const second = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "another-real-password-456" });

    expect(second.status).toBe(404);
  });

  it("rejects a password shorter than the minimum", async () => {
    const token = createTestInvite({ purpose: "signup", suggestedUsername: "short-pw-user" });
    const res = await request(app).post(`/api/v1/auth/invites/${token}/complete`).send({ password: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects a username that's already taken", async () => {
    const existing = createTestUserWithTotp();
    const existingUsername = getUserById(existing.id).username;
    const token = createTestInvite({ purpose: "signup", suggestedUsername: existingUsername });

    const res = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "a-real-password-123" });

    expect(res.status).toBe(409);
  });
});

describe("POST /api/v1/auth/invites/:token/complete — password_reset", () => {
  it("updates the target user's password without issuing a session", async () => {
    const user = createTestUserWithTotp({ role: "user" });
    const token = createTestInvite({ purpose: "password_reset", targetUserId: user.id });

    const res = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "brand-new-password-789" });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();

    const updated = getUserById(user.id);
    expect(verifyPassword("brand-new-password-789", updated.passwordHash)).toBe(true);
  });
});

describe("TOTP enrollment (via invite signup)", () => {
  it("start returns a secret + QR, confirm issues a session and recovery codes", async () => {
    const token = createTestInvite({ purpose: "signup", suggestedUsername: "enroll-flow-user" });

    const complete = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "a-real-password-123" });

    const { enrollmentToken } = complete.body;

    const start = await request(app).post("/api/v1/auth/enroll/start").send({ enrollmentToken });
    expect(start.status).toBe(200);
    expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    const code = currentTotpCode(start.body.secret);

    const confirm = await request(app).post("/api/v1/auth/enroll/confirm").send({ enrollmentToken, code });

    expect(confirm.status).toBe(201);
    expect(confirm.body.recoveryCodes).toHaveLength(8);
    expect(confirm.body.csrfToken).toBeTruthy();
    expect(confirm.headers["set-cookie"]?.[0]).toContain("bs_session=");

    const created = getUserByUsername("enroll-flow-user");
    expect(created.totpEnabled).toBe(1);
  });

  it("rejects a wrong confirmation code", async () => {
    const token = createTestInvite({ purpose: "signup", suggestedUsername: "wrong-code-user" });
    const complete = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "a-real-password-123" });

    await request(app).post("/api/v1/auth/enroll/start").send({ enrollmentToken: complete.body.enrollmentToken });

    const confirm = await request(app)
      .post("/api/v1/auth/enroll/confirm")
      .send({ enrollmentToken: complete.body.enrollmentToken, code: "000000" });

    expect(confirm.status).toBe(401);
  });

  it("rejects confirm before start (no secret generated yet)", async () => {
    const token = createTestInvite({ purpose: "signup", suggestedUsername: "no-start-user" });
    const complete = await request(app)
      .post(`/api/v1/auth/invites/${token}/complete`)
      .send({ password: "a-real-password-123" });

    const confirm = await request(app)
      .post("/api/v1/auth/enroll/confirm")
      .send({ enrollmentToken: complete.body.enrollmentToken, code: "123456" });

    expect(confirm.status).toBe(410);
  });
});

describe("request-access", () => {
  async function getChallenge() {
    const res = await request(app).get("/api/v1/request-access/challenge");
    const [a, b] = res.body.question.split(" + ").map(Number);
    return { ...res.body, answer: a + b };
  }

  it("submits a real request when the challenge is answered correctly", async () => {
    const challenge = await getChallenge();

    // The endpoint silently discards a *correct* answer submitted faster
    // than 3s (bot-shaped: solved programmatically, submitted instantly)
    // — a real human always takes longer than this, but so does this
    // test needing to prove the genuine, not-too-fast path.
    await new Promise((resolve) => setTimeout(resolve, 3100));

    const res = await request(app).post("/api/v1/request-access").send({
      username: "hopeful-new-user",
      email: "hopeful@example.com",
      message: "please let me in",
      honeypot: "",
      challengeId: challenge.challengeId,
      answer: challenge.answer,
    });

    expect(res.status).toBe(202);

    const requests = listSignupRequests();
    expect(requests.some((r) => r.requestedUsername === "hopeful-new-user")).toBe(true);
  }, 8000);

  it("rejects a wrong answer with a real error", async () => {
    const challenge = await getChallenge();

    const res = await request(app).post("/api/v1/request-access").send({
      username: "wrong-answer-user",
      honeypot: "",
      challengeId: challenge.challengeId,
      answer: challenge.answer + 1,
    });

    expect(res.status).toBe(400);
    expect(listSignupRequests().some((r) => r.requestedUsername === "wrong-answer-user")).toBe(false);
  });

  it("silently swallows a honeypot-filled (bot-shaped) submission", async () => {
    const challenge = await getChallenge();

    const res = await request(app).post("/api/v1/request-access").send({
      username: "bot-user-honeypot",
      honeypot: "I am a bot",
      challengeId: challenge.challengeId,
      answer: challenge.answer,
    });

    expect(res.status).toBe(202);
    expect(listSignupRequests().some((r) => r.requestedUsername === "bot-user-honeypot")).toBe(false);
  });

  it("silently swallows a too-fast (bot-shaped) submission", async () => {
    const challenge = await getChallenge();

    // Submitted in the same tick as fetching the challenge — well under
    // the 3s minimum dwell time.
    const res = await request(app).post("/api/v1/request-access").send({
      username: "bot-user-fast",
      honeypot: "",
      challengeId: challenge.challengeId,
      answer: challenge.answer,
    });

    expect(res.status).toBe(202);
    expect(listSignupRequests().some((r) => r.requestedUsername === "bot-user-fast")).toBe(false);
  });

  it("rejects a forged/tampered challenge", async () => {
    const challenge = await getChallenge();
    const [a, b, renderedAt] = challenge.challengeId.split(".");
    const tampered = `${a}.${Number(b) + 1}.${renderedAt}.${challenge.challengeId.split(".")[3]}`;

    const res = await request(app).post("/api/v1/request-access").send({
      username: "forged-user",
      honeypot: "",
      challengeId: tampered,
      answer: challenge.answer,
    });

    expect(res.status).toBe(400);
  });
});
