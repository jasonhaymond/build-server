import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { createBuild, updateBuild } from "../src/db/database.mjs";
import { registerArtifact } from "../src/worker/artifacts.mjs";
import { createTestApiKey } from "./helpers.mjs";

// The artifacts table is populated by the worker at build time, not the
// API — registering one directly here exercises the same real DB writes
// a real build would produce, without needing a real Android build.
const buildId = "bld_test_artifact_fixture";
const artifactsDir = resolve(process.cwd(), "builds", buildId, "artifacts");
const artifactPath = resolve(artifactsDir, "app-release.apk");

beforeAll(() => {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(artifactPath, "fake apk contents");

  createBuild({
    id: buildId,
    projectName: "ArtifactFixture",
    submittedAt: new Date().toISOString(),
    platform: "android",
  });
  updateBuild(buildId, {
    status: "completed",
    completedAt: new Date().toISOString(),
    exitCode: 0,
  });

  registerArtifact({
    buildId,
    filename: "app-release.apk",
    type: "apk",
    path: artifactPath,
  });
});

afterAll(() => {
  rmSync(resolve(process.cwd(), "builds", buildId), { recursive: true, force: true });
});

describe("artifact lifecycle", () => {
  it("lists the artifact with a permanent download URL", async () => {
    const key = createTestApiKey({ scopes: ["artifact:download"] });

    const res = await request(app)
      .get(`/api/v1/builds/${buildId}/artifacts`)
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.artifacts).toHaveLength(1);
    expect(res.body.artifacts[0].filename).toBe("app-release.apk");
    expect(res.body.artifacts[0].downloadUrl).toContain("/download/");
  });

  it("serves the public download with no auth, then 404s after revocation", async () => {
    const key = createTestApiKey({ scopes: ["artifact:download", "artifact:manage"] });

    const list = await request(app)
      .get(`/api/v1/builds/${buildId}/artifacts`)
      .set("Authorization", `Bearer ${key}`);

    const downloadPath = new URL(list.body.artifacts[0].downloadUrl).pathname;

    const download = await request(app).get(downloadPath);
    expect(download.status).toBe(200);
    expect(download.text).toBe("fake apk contents");

    const revoke = await request(app)
      .delete(`/api/v1/builds/${buildId}/artifacts/app-release.apk/download-token`)
      .set("Authorization", `Bearer ${key}`);
    expect(revoke.status).toBe(200);

    const afterRevoke = await request(app).get(downloadPath);
    expect(afterRevoke.status).toBe(404);
  });

  it("rejects artifact listing without artifact:download scope", async () => {
    const key = createTestApiKey({ scopes: ["build:read"] });

    const res = await request(app)
      .get(`/api/v1/builds/${buildId}/artifacts`)
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(403);
  });
});
