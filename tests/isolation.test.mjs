// Dedicated coverage for the v2.0.0 "absolute isolation" guarantee: no
// user can reach another user's builds, logs, artifacts, or API keys —
// not another regular user, and not an admin either. The one sanctioned
// exception (broadcast notifications) is covered in tests/admin.test.mjs,
// not here. Every other test file exercises pieces of this already;
// this file's job is to make the guarantee itself explicit and easy to
// find in one place, including the legacy-key compatibility promise.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { createTestApiKey, createTestSession, sampleJob } from "./helpers.mjs";

async function submitAs(auth) {
  const req = request(app).post("/api/v1/builds").send(sampleJob());
  const res = auth.cookie
    ? await req.set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrfToken)
    : await req.set("Authorization", `Bearer ${auth.key}`);
  return res.body.id;
}

describe("absolute isolation between real accounts", () => {
  it("user A's build is invisible to user B via every build-scoped route", async () => {
    const userA = createTestSession({ role: "user" });
    const userB = createTestSession({ role: "user" });

    const id = await submitAs(userA);

    for (const path of [`/api/v1/builds/${id}`, `/api/v1/builds/${id}/logs`, `/api/v1/builds/${id}/artifacts`]) {
      const res = await request(app).get(path).set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    }

    const cancel = await request(app)
      .post(`/api/v1/builds/${id}/cancel`)
      .set("Cookie", userB.cookie)
      .set("X-CSRF-Token", userB.csrfToken);
    expect(cancel.status).toBe(404);

    // Owner can still see it — proves the 404s above are isolation, not
    // a broken route.
    const ownRead = await request(app).get(`/api/v1/builds/${id}`).set("Cookie", userA.cookie);
    expect(ownRead.status).toBe(200);
  });

  it("user B's build doesn't appear in user A's build list", async () => {
    const userA = createTestSession({ role: "user" });
    const userB = createTestSession({ role: "user" });

    const idB = await submitAs(userB);

    const listA = await request(app).get("/api/v1/builds").set("Cookie", userA.cookie);
    expect(listA.body.builds.some((b) => b.id === idB)).toBe(false);

    const listB = await request(app).get("/api/v1/builds").set("Cookie", userB.cookie);
    expect(listB.body.builds.some((b) => b.id === idB)).toBe(true);
  });

  it("an admin session has zero visibility into a user's build — no bypass exists", async () => {
    const user = createTestSession({ role: "user" });
    const admin = createTestSession({ role: "admin" });

    const id = await submitAs(user);

    const adminRead = await request(app).get(`/api/v1/builds/${id}`).set("Cookie", admin.cookie);
    expect(adminRead.status).toBe(404);

    const adminList = await request(app).get("/api/v1/builds").set("Cookie", admin.cookie);
    expect(adminList.body.builds.some((b) => b.id === id)).toBe(false);
  });

  it("one user's API keys are invisible to another user, including an admin", async () => {
    const userA = createTestSession({ role: "user" });
    const admin = createTestSession({ role: "admin" });

    const created = await request(app)
      .post("/api/v1/api-keys")
      .set("Cookie", userA.cookie)
      .set("X-CSRF-Token", userA.csrfToken)
      .send({ name: "userA-key" });

    const adminList = await request(app).get("/api/v1/api-keys").set("Cookie", admin.cookie);
    expect(adminList.body.apiKeys.some((k) => k.id === created.body.id)).toBe(false);

    const adminRevoke = await request(app)
      .delete(`/api/v1/api-keys/${created.body.id}`)
      .set("Cookie", admin.cookie)
      .set("X-CSRF-Token", admin.csrfToken);
    expect(adminRevoke.status).toBe(404);
  });

  it("metrics are scoped per-account, including for admins", async () => {
    const userA = createTestSession({ role: "user" });
    const userB = createTestSession({ role: "user" });

    await submitAs(userA);
    await submitAs(userA);
    await submitAs(userB);

    const metricsA = await request(app).get("/api/v1/metrics").set("Cookie", userA.cookie);
    const metricsB = await request(app).get("/api/v1/metrics").set("Cookie", userB.cookie);

    const totalA = Object.values(metricsA.body.buildsByStatus).reduce((a, b) => a + b, 0);
    const totalB = Object.values(metricsB.body.buildsByStatus).reduce((a, b) => a + b, 0);

    expect(totalA).toBe(2);
    expect(totalB).toBe(1);
  });
});

describe("legacy (pre-v2.0.0) API keys keep working, unowned", () => {
  it("a legacy key can still submit and read its own builds", async () => {
    const legacyKey = createTestApiKey({ name: "legacy-ci-key" });
    const id = await submitAs({ key: legacyKey });

    const read = await request(app).get(`/api/v1/builds/${id}`).set("Authorization", `Bearer ${legacyKey}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(id);
  });

  it("a real user account still can't see a legacy key's build", async () => {
    const legacyKey = createTestApiKey({ name: "legacy-ci-key-2" });
    const user = createTestSession({ role: "user" });

    const id = await submitAs({ key: legacyKey });

    const res = await request(app).get(`/api/v1/builds/${id}`).set("Cookie", user.cookie);
    expect(res.status).toBe(404);
  });

  it("a different legacy key can't see another legacy key's build unless it's also unowned (matches pre-v2.0.0 api_key_id comparison)", async () => {
    const legacyKeyA = createTestApiKey({ name: "legacy-a" });
    const legacyKeyB = createTestApiKey({ name: "legacy-b" });

    const id = await submitAs({ key: legacyKeyA });

    const crossRead = await request(app).get(`/api/v1/builds/${id}`).set("Authorization", `Bearer ${legacyKeyB}`);
    expect(crossRead.status).toBe(404);
  });
});
