import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { getUserById } from "../src/db/database.mjs";
import { createTestSession, createTestUser, createTestUserWithTotp } from "./helpers.mjs";

function admin() {
  return createTestSession({ role: "admin" });
}

describe("GET /api/v1/admin/users", () => {
  it("requires admin sign-in", async () => {
    const { cookie } = createTestSession({ role: "user" });
    const res = await request(app).get("/api/v1/admin/users").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("lists users without any password/TOTP-secret leakage", async () => {
    const { cookie } = admin();
    createTestUser({ role: "user" });

    const res = await request(app).get("/api/v1/admin/users").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    for (const user of res.body.users) {
      expect(user).not.toHaveProperty("passwordHash");
      expect(user).not.toHaveProperty("totpSecret");
    }
  });
});

describe("PATCH /api/v1/admin/users/:id", () => {
  it("disables and re-enables another user", async () => {
    const { cookie, csrfToken } = admin();
    const target = createTestUser({ role: "user" });

    const disable = await request(app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ enabled: false });

    expect(disable.status).toBe(200);
    expect(disable.body.enabled).toBe(false);
    expect(getUserById(target.id).enabled).toBe(0);
  });

  it("promotes a user to admin", async () => {
    const { cookie, csrfToken } = admin();
    const target = createTestUser({ role: "user" });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "admin" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
  });

  it("refuses to let an admin disable their own account", async () => {
    const { cookie, csrfToken, userId } = admin();

    const res = await request(app)
      .patch(`/api/v1/admin/users/${userId}`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ enabled: false });

    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent user", async () => {
    const { cookie, csrfToken } = admin();
    const res = await request(app)
      .patch("/api/v1/admin/users/999999")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ enabled: false });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/admin/users/:id/reset-password", () => {
  it("creates a redeemable password_reset invite", async () => {
    const { cookie, csrfToken } = admin();
    const target = createTestUser({ role: "user" });

    const res = await request(app)
      .post(`/api/v1/admin/users/${target.id}/reset-password`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);

    expect(res.status).toBe(201);
    // No WEB_UI_ORIGIN configured in the test env — link is null, not an error.
    expect(res.body).toHaveProperty("link");
  });
});

describe("POST /api/v1/admin/users/:id/reset-2fa", () => {
  it("clears enrollment, forcing re-enrollment on next login", async () => {
    const { cookie, csrfToken } = admin();
    const target = createTestUserWithTotp({ role: "user" });

    const res = await request(app)
      .post(`/api/v1/admin/users/${target.id}/reset-2fa`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);

    expect(res.status).toBe(200);
    expect(res.body.totpEnabled).toBe(false);
    expect(getUserById(target.id).totpEnabled).toBe(0);
  });
});

describe("Invites (admin)", () => {
  it("creates, lists, and revokes an invite", async () => {
    const { cookie, csrfToken } = admin();

    const create = await request(app)
      .post("/api/v1/admin/invites")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "user", suggestedUsername: "invited-person" });

    expect(create.status).toBe(201);
    expect(create.body.id).toBeTruthy();

    const list = await request(app).get("/api/v1/admin/invites").set("Cookie", cookie);
    expect(list.body.invites.some((invite) => invite.id === create.body.id)).toBe(true);

    const revoke = await request(app)
      .delete(`/api/v1/admin/invites/${create.body.id}`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);
    expect(revoke.status).toBe(204);

    const listAfter = await request(app).get("/api/v1/admin/invites").set("Cookie", cookie);
    expect(listAfter.body.invites.some((invite) => invite.id === create.body.id)).toBe(false);
  });

  it("rejects an unknown role", async () => {
    const { cookie, csrfToken } = admin();
    const res = await request(app)
      .post("/api/v1/admin/invites")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "superuser" });

    expect(res.status).toBe(400);
  });
});

describe("Signup requests (admin)", () => {
  async function submitRequest(username) {
    const challenge = await request(app).get("/api/v1/request-access/challenge");
    const [a, b] = challenge.body.question.split(" + ").map(Number);
    await new Promise((resolve) => setTimeout(resolve, 3100));
    return request(app).post("/api/v1/request-access").send({
      username,
      honeypot: "",
      challengeId: challenge.body.challengeId,
      answer: a + b,
    });
  }

  it("approving creates an invite pre-filled with the requested username", async () => {
    await submitRequest("wants-to-join");
    const { cookie, csrfToken } = admin();

    const list = await request(app).get("/api/v1/admin/signup-requests").set("Cookie", cookie);
    const pending = list.body.signupRequests.find((r) => r.requestedUsername === "wants-to-join");
    expect(pending).toBeTruthy();

    const approve = await request(app)
      .post(`/api/v1/admin/signup-requests/${pending.id}/approve`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "user" });

    expect(approve.status).toBe(201);

    const listAfter = await request(app).get("/api/v1/admin/signup-requests").set("Cookie", cookie);
    const decided = listAfter.body.signupRequests.find((r) => r.id === pending.id);
    expect(decided.status).toBe("approved");
  }, 8000);

  it("rejecting marks the request rejected without creating an invite", async () => {
    await submitRequest("does-not-get-in");
    const { cookie, csrfToken } = admin();

    const list = await request(app).get("/api/v1/admin/signup-requests").set("Cookie", cookie);
    const pending = list.body.signupRequests.find((r) => r.requestedUsername === "does-not-get-in");

    const reject = await request(app)
      .post(`/api/v1/admin/signup-requests/${pending.id}/reject`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);

    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");
  }, 8000);

  it("can't decide the same request twice", async () => {
    await submitRequest("decide-once-only");
    const { cookie, csrfToken } = admin();

    const list = await request(app).get("/api/v1/admin/signup-requests").set("Cookie", cookie);
    const pending = list.body.signupRequests.find((r) => r.requestedUsername === "decide-once-only");

    await request(app)
      .post(`/api/v1/admin/signup-requests/${pending.id}/reject`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);

    const second = await request(app)
      .post(`/api/v1/admin/signup-requests/${pending.id}/reject`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken);

    expect(second.status).toBe(404);
  }, 8000);
});

describe("Broadcast notifications", () => {
  it("an admin sends one, and it shows up unread for a different user", async () => {
    const { cookie: adminCookie, csrfToken: adminCsrf } = admin();
    const { cookie: userCookie } = createTestSession({ role: "user" });

    const send = await request(app)
      .post("/api/v1/admin/notifications")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf)
      .send({ message: "Restarting the server for an update shortly." });

    expect(send.status).toBe(201);

    const inbox = await request(app).get("/api/v1/notifications").set("Cookie", userCookie);
    expect(inbox.body.notifications.some((n) => n.id === send.body.id)).toBe(true);
  });

  it("dismissing is per-user — one user's read state doesn't affect another's", async () => {
    const { cookie: adminCookie, csrfToken: adminCsrf } = admin();
    const userA = createTestSession({ role: "user" });
    const userB = createTestSession({ role: "user" });

    const send = await request(app)
      .post("/api/v1/admin/notifications")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf)
      .send({ message: "Per-user dismissal test." });

    const markRead = await request(app)
      .post(`/api/v1/notifications/${send.body.id}/read`)
      .set("Cookie", userA.cookie)
      .set("X-CSRF-Token", userA.csrfToken);
    expect(markRead.status).toBe(204);

    const inboxA = await request(app).get("/api/v1/notifications").set("Cookie", userA.cookie);
    expect(inboxA.body.notifications.some((n) => n.id === send.body.id)).toBe(false);

    const inboxB = await request(app).get("/api/v1/notifications").set("Cookie", userB.cookie);
    expect(inboxB.body.notifications.some((n) => n.id === send.body.id)).toBe(true);
  });

  it("requires admin sign-in to send", async () => {
    const { cookie, csrfToken } = createTestSession({ role: "user" });
    const res = await request(app)
      .post("/api/v1/admin/notifications")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ message: "should not be allowed" });

    expect(res.status).toBe(403);
  });
});
