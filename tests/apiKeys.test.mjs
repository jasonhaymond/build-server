import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { createTestSession } from "./helpers.mjs";

async function createKey(session, name = "test-key") {
  return request(app)
    .post("/api/v1/api-keys")
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken)
    .send({ name });
}

describe("DELETE /api/v1/api-keys/:id (revoke)", () => {
  it("disables the key but keeps its row (still listed, marked revoked)", async () => {
    const session = createTestSession({ role: "user" });
    const created = await createKey(session);

    const revoke = await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}`)
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken);

    expect(revoke.status).toBe(200);
    expect(revoke.body.enabled).toBe(false);

    const list = await request(app).get("/api/v1/api-keys").set("Cookie", session.cookie);
    const found = list.body.apiKeys.find((k) => k.id === created.body.id);
    expect(found).toBeTruthy();
    expect(found.enabled).toBe(false);
  });

  it("404s for another user's key", async () => {
    const owner = createTestSession({ role: "user" });
    const attacker = createTestSession({ role: "user" });
    const created = await createKey(owner);

    const res = await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}`)
      .set("Cookie", attacker.cookie)
      .set("X-CSRF-Token", attacker.csrfToken);

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/api-keys/:id/purge (permanent delete)", () => {
  it("refuses to purge a key that hasn't been revoked yet", async () => {
    const session = createTestSession({ role: "user" });
    const created = await createKey(session);

    const res = await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}/purge`)
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken);

    expect(res.status).toBe(409);

    // Still there afterward — the refusal didn't half-apply.
    const list = await request(app).get("/api/v1/api-keys").set("Cookie", session.cookie);
    expect(list.body.apiKeys.some((k) => k.id === created.body.id)).toBe(true);
  });

  it("permanently removes an already-revoked key", async () => {
    const session = createTestSession({ role: "user" });
    const created = await createKey(session);

    await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}`)
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken);

    const purge = await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}/purge`)
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken);

    expect(purge.status).toBe(204);

    const list = await request(app).get("/api/v1/api-keys").set("Cookie", session.cookie);
    expect(list.body.apiKeys.some((k) => k.id === created.body.id)).toBe(false);
  });

  it("404s for another user's revoked key rather than purging it", async () => {
    const owner = createTestSession({ role: "user" });
    const attacker = createTestSession({ role: "user" });
    const created = await createKey(owner);

    await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken);

    const res = await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}/purge`)
      .set("Cookie", attacker.cookie)
      .set("X-CSRF-Token", attacker.csrfToken);

    expect(res.status).toBe(404);

    const list = await request(app).get("/api/v1/api-keys").set("Cookie", owner.cookie);
    expect(list.body.apiKeys.some((k) => k.id === created.body.id)).toBe(true);
  });

  it("404s for a nonexistent key id", async () => {
    const session = createTestSession({ role: "user" });

    const res = await request(app)
      .delete("/api/v1/api-keys/999999/purge")
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken);

    expect(res.status).toBe(404);
  });
});
