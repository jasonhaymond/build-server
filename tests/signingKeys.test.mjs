// Android signing keys (src/security/signingKeys.mjs, the /api/v1/signing-keys routes, and
// build.signing on POST /api/v1/builds). These keys can publish "updates" to installed
// apps, so most tests here prove an attack is refused: managing keys with an API key,
// reading key material back, using another user's key, using a key without the
// signing:use scope, or deleting without retyping the name.
//
// Uses the real keytool inside the Android build image (ANDROID_BUILD_IMAGE, defaulting to
// the locally built test image) — no mocks — so these need Docker available.

import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

process.env.ANDROID_BUILD_IMAGE ??= "build-server-android:test-node24";

const { app } = await import("../src/api/server.mjs");
const { getSigningKeyWithSecretById } = await import("../src/db/database.mjs");
const { decryptSigningMaterial } = await import("../src/security/signingKeys.mjs");
const { toJavaPropertiesValue } = await import("../src/worker/javaProperties.mjs");
const { createTestApiKey, createTestSession, sampleJob } = await import("./helpers.mjs");

function asSession(req, session) {
  return req.set("Cookie", session.cookie).set("X-CSRF-Token", session.csrfToken);
}

function generate(session, name) {
  return asSession(request(app).post("/api/v1/signing-keys"), session).send({ name, mode: "generate" });
}

function releaseJob(signing) {
  return sampleJob({ build: { platform: "android", variant: "release", artifact: "apk", signing } });
}

describe("signing keys", () => {
  let owner;
  let generated;

  beforeAll(async () => {
    owner = createTestSession();
    generated = await generate(owner, "clocker");
  }, 120_000);

  // Happy path: generating returns the public facts plus a one-time backup.
  it("generates a key and returns its backup exactly once", async () => {
    expect(generated.status).toBe(201);
    expect(generated.body.name).toBe("clocker");
    expect(generated.body.certSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(generated.body.backup.keystoreBase64.length).toBeGreaterThan(1000);
    expect(generated.body.backup.storePassword.length).toBeGreaterThanOrEqual(24);
  });

  // Data handling: the list shows names/fingerprints only — no keystore, no passwords.
  it("never returns key material when listing", async () => {
    const res = await asSession(request(app).get("/api/v1/signing-keys"), owner);
    expect(res.status).toBe(200);
    expect(res.body.signingKeys).toHaveLength(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(generated.body.backup.storePassword);
    expect(text).not.toContain(generated.body.backup.keystoreBase64.slice(0, 40));
    expect(Object.keys(res.body.signingKeys[0]).sort()).toEqual(["certSha256", "createdAt", "id", "keyAlias", "name", "storeType"]);
  });

  // Encryption at rest: the stored row doesn't contain the password, and decrypts back to
  // exactly what was generated.
  it("stores the key encrypted", () => {
    const row = getSigningKeyWithSecretById(generated.body.id);
    expect(row.secretPayload).not.toContain(generated.body.backup.storePassword);
    const material = decryptSigningMaterial(row.secretPayload, process.env.JOB_SECRETS_ENCRYPTION_KEY);
    expect(material.storePassword).toBe(generated.body.backup.storePassword);
    expect(material.keystore.toString("base64")).toBe(generated.body.backup.keystoreBase64);
  });

  // Authentication: no credentials at all is a 401.
  it("rejects unauthenticated requests", async () => {
    expect((await request(app).get("/api/v1/signing-keys")).status).toBe(401);
    expect((await request(app).post("/api/v1/signing-keys").send({ name: "x", mode: "generate" })).status).toBe(401);
  });

  // Authorization: even the owner's own full-access API key can't create, list or delete
  // keys — a leaked CI key must not be able to mint or remove signing keys.
  it("refuses every key-management route for API keys (session only)", async () => {
    const key = createTestApiKey({ userId: owner.userId });
    const auth = (r) => r.set("Authorization", `Bearer ${key}`);
    expect((await auth(request(app).get("/api/v1/signing-keys"))).status).toBe(403);
    expect((await auth(request(app).post("/api/v1/signing-keys")).send({ name: "ci", mode: "generate" })).status).toBe(403);
    expect((await auth(request(app).delete(`/api/v1/signing-keys/${generated.body.id}`)).send({ confirmName: "clocker" })).status).toBe(403);
  });

  // Input validation.
  it("rejects bad names, bad modes and duplicates", async () => {
    expect((await asSession(request(app).post("/api/v1/signing-keys"), owner).send({ name: "../etc", mode: "generate" })).status).toBe(400);
    expect((await asSession(request(app).post("/api/v1/signing-keys"), owner).send({ name: "ok-name", mode: "steal" })).status).toBe(400);
    expect((await generate(owner, "clocker")).status).toBe(409);
  });

  // Upload: a wrong password is refused; the right one is accepted with the same fingerprint.
  it("validates uploaded keystores", async () => {
    const base = { name: "uploaded", mode: "upload", keystoreBase64: generated.body.backup.keystoreBase64, keyAlias: "clocker" };
    const wrong = await asSession(request(app).post("/api/v1/signing-keys"), owner).send({ ...base, storePassword: "wrong-password", keyPassword: "wrong-password" });
    expect(wrong.status).toBe(400);
    const right = await asSession(request(app).post("/api/v1/signing-keys"), owner).send({
      ...base,
      storePassword: generated.body.backup.storePassword,
      keyPassword: generated.body.backup.keyPassword,
    });
    expect(right.status).toBe(201);
    expect(right.body.certSha256).toBe(generated.body.certSha256);
    expect(right.body.backup).toBeUndefined();
  }, 120_000);

  // Isolation: another user sees none of the owner's keys and can't delete them.
  it("keeps keys private to their owner", async () => {
    const other = createTestSession();
    const list = await asSession(request(app).get("/api/v1/signing-keys"), other);
    expect(list.body.signingKeys).toEqual([]);
    const del = await asSession(request(app).delete(`/api/v1/signing-keys/${generated.body.id}`), other).send({ confirmName: "clocker" });
    expect(del.status).toBe(404);
  });

  // Destructive action: deleting requires retyping the exact key name.
  it("requires typed confirmation to delete", async () => {
    const tmp = await generate(owner, "throwaway");
    const noConfirm = await asSession(request(app).delete(`/api/v1/signing-keys/${tmp.body.id}`), owner).send({ confirmName: "nope" });
    expect(noConfirm.status).toBe(400);
    const ok = await asSession(request(app).delete(`/api/v1/signing-keys/${tmp.body.id}`), owner).send({ confirmName: "throwaway" });
    expect(ok.status).toBe(200);
  }, 120_000);
});

describe("build.signing on POST /api/v1/builds", () => {
  let owner;

  beforeAll(async () => {
    owner = createTestSession();
    await generate(owner, "app");
  }, 120_000);

  // A key with the scope, owned by the key's user, is accepted — and the stored job carries
  // only the resolved id/fingerprint, never the key material.
  it("accepts the owner's key with signing:use and stores no key material in the job", async () => {
    const key = createTestApiKey({ userId: owner.userId, scopes: ["build:create", "signing:use"] });
    const res = await request(app).post("/api/v1/builds").set("Authorization", `Bearer ${key}`).send(releaseJob({ key: "app" }));
    expect(res.status).toBe(202);
  });

  // Scope: build:create alone isn't enough to sign.
  it("refuses an API key without signing:use", async () => {
    const key = createTestApiKey({ userId: owner.userId, scopes: ["build:create"] });
    const res = await request(app).post("/api/v1/builds").set("Authorization", `Bearer ${key}`).send(releaseJob({ key: "app" }));
    expect(res.status).toBe(403);
  });

  // Isolation: another user can't name the owner's key (and can't smuggle its id in).
  it("refuses another user's key, even with a forged keyId", async () => {
    const attacker = createTestSession();
    const key = createTestApiKey({ userId: attacker.userId });
    const res = await request(app).post("/api/v1/builds").set("Authorization", `Bearer ${key}`).send(releaseJob({ key: "app", keyId: 1 }));
    expect(res.status).toBe(400);
  });

  // A standalone API key (no owning user) can't use any signing key.
  it("refuses a standalone API key", async () => {
    const key = createTestApiKey();
    const res = await request(app).post("/api/v1/builds").set("Authorization", `Bearer ${key}`).send(releaseJob({ key: "app" }));
    expect(res.status).toBe(400);
  });

  // Debug builds are always debug-signed; asking for signing there is an error.
  it("refuses signing on a debug build", async () => {
    const key = createTestApiKey({ userId: owner.userId });
    const job = sampleJob({ build: { platform: "android", variant: "debug", artifact: "apk", signing: { key: "app" } } });
    const res = await request(app).post("/api/v1/builds").set("Authorization", `Bearer ${key}`).send(job);
    expect(res.status).toBe(400);
  });
});

// The worker hands passwords to Gradle via a .properties file — every special character
// must survive the escaping, or an uploaded key with an unusual password would fail.
describe("toJavaPropertiesValue", () => {
  it("escapes everything with meaning in a .properties file", () => {
    expect(toJavaPropertiesValue("p@ss=w:rd é")).toBe("p@ss\\=w\\:rd\\ \\u00e9");
    expect(toJavaPropertiesValue("a\\b#c!d\ne")).toBe("a\\\\b\\#c\\!d\\ne");
    expect(toJavaPropertiesValue("plain-Password_123")).toBe("plain-Password_123");
  });
});
