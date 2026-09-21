import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { createTestApiKey, sampleJob } from "./helpers.mjs";

describe("authentication", () => {
  it("rejects requests with no Authorization header", async () => {
    const res = await request(app).get("/api/v1/builds/nonexistent");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await request(app)
      .get("/api/v1/builds/nonexistent")
      .set("Authorization", "not-a-bearer-token");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid API key", async () => {
    const res = await request(app)
      .get("/api/v1/builds/nonexistent")
      .set("Authorization", "Bearer abs_totallyinvalid");
    expect(res.status).toBe(401);
  });

  it("accepts a valid key (authenticated, build simply not found)", async () => {
    const key = createTestApiKey();
    const res = await request(app)
      .get("/api/v1/builds/nonexistent")
      .set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/whoami", () => {
  it("accepts any valid key regardless of scopes", async () => {
    const key = createTestApiKey({ name: "admin-only", scopes: ["system:manage"] });
    const res = await request(app).get("/api/v1/whoami").set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("admin-only");
    expect(res.body.scopes).toEqual(["system:manage"]);
  });
});

describe("build submission validation", () => {
  it("rejects a non-object body", async () => {
    const key = createTestApiKey();
    const res = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`)
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
  });

  it("rejects a missing project.name", async () => {
    const key = createTestApiKey();
    const res = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`)
      .send({ project: {}, build: {} });
    expect(res.status).toBe(400);
  });

  it("queues a valid submission", async () => {
    const key = createTestApiKey();
    const res = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`)
      .send(sampleJob());

    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^bld_/);
  });

  it("returns the project name in the build's status response", async () => {
    const key = createTestApiKey();
    const submit = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`)
      .send(sampleJob({ project: { name: "NamedProject", source: sampleJob().project.source } }));

    const res = await request(app)
      .get(`/api/v1/builds/${submit.body.id}`)
      .set("Authorization", `Bearer ${key}`);

    expect(res.body.projectName).toBe("NamedProject");
  });
});

describe("build listing", () => {
  it("lists only the caller's own builds by default", async () => {
    const keyA = createTestApiKey({ name: "list-a", scopes: ["build:create", "build:read"] });
    const keyB = createTestApiKey({ name: "list-b", scopes: ["build:create", "build:read"] });

    const submitted = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${keyA}`)
      .send(sampleJob());

    const listA = await request(app)
      .get("/api/v1/builds")
      .set("Authorization", `Bearer ${keyA}`);
    expect(listA.status).toBe(200);
    expect(listA.body.builds.some((b) => b.id === submitted.body.id)).toBe(true);

    const listB = await request(app)
      .get("/api/v1/builds")
      .set("Authorization", `Bearer ${keyB}`);
    expect(listB.body.builds.some((b) => b.id === submitted.body.id)).toBe(false);
  });

  it("requires build:read", async () => {
    const key = createTestApiKey({ scopes: ["build:create"] });
    const res = await request(app)
      .get("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(403);
  });
});

describe("scopes", () => {
  it("rejects build:create when the key lacks that scope", async () => {
    const key = createTestApiKey({ scopes: ["build:read"] });
    const res = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`)
      .send(sampleJob());

    expect(res.status).toBe(403);
  });

  it("a full-access key (no scopes recorded) can create builds", async () => {
    const key = createTestApiKey();
    const res = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${key}`)
      .send(sampleJob());

    expect(res.status).toBe(202);
  });

  it("rejects metrics access without metrics:read", async () => {
    const key = createTestApiKey({ scopes: ["build:create"] });
    const res = await request(app)
      .get("/api/v1/metrics")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(403);
  });

  it("allows metrics access with metrics:read", async () => {
    const key = createTestApiKey({ scopes: ["metrics:read"] });
    const res = await request(app)
      .get("/api/v1/metrics")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("buildsByStatus");
  });
});

describe("multi-tenant isolation", () => {
  // Isolation only applies between scoped keys — an unscoped ("legacy
  // full access") key intentionally keeps its pre-existing ability to see
  // any build, since that's the behavior it had before multi-tenancy
  // existed (see hasScope's null-scopes handling).
  const scopedKeyScopes = ["build:create", "build:read", "build:cancel"];

  it("a build is invisible to a different API key", async () => {
    const keyA = createTestApiKey({ name: "tenant-a", scopes: scopedKeyScopes });
    const keyB = createTestApiKey({ name: "tenant-b", scopes: scopedKeyScopes });

    const submit = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${keyA}`)
      .send(sampleJob({ project: { name: "TenantIsolation", source: sampleJob().project.source } }));

    const id = submit.body.id;

    const ownRead = await request(app)
      .get(`/api/v1/builds/${id}`)
      .set("Authorization", `Bearer ${keyA}`);
    expect(ownRead.status).toBe(200);

    const crossRead = await request(app)
      .get(`/api/v1/builds/${id}`)
      .set("Authorization", `Bearer ${keyB}`);
    expect(crossRead.status).toBe(404);

    const crossCancel = await request(app)
      .post(`/api/v1/builds/${id}/cancel`)
      .set("Authorization", `Bearer ${keyB}`);
    expect(crossCancel.status).toBe(404);
  });

  it("a key with build:read + build:read:any can see another key's build", async () => {
    const keyA = createTestApiKey({ name: "tenant-c" });
    const adminKey = createTestApiKey({
      name: "admin",
      scopes: ["build:read", "build:read:any"],
    });

    const submit = await request(app)
      .post("/api/v1/builds")
      .set("Authorization", `Bearer ${keyA}`)
      .send(sampleJob());

    const id = submit.body.id;

    const adminRead = await request(app)
      .get(`/api/v1/builds/${id}`)
      .set("Authorization", `Bearer ${adminKey}`);

    expect(adminRead.status).toBe(200);
    expect(adminRead.body.id).toBe(id);
  });
});
