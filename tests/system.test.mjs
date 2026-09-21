import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/api/server.mjs";
import { buildUpdateRunnerArgs } from "../src/system/update.mjs";
import { createTestApiKey } from "./helpers.mjs";

describe("GET /api/v1/system", () => {
  it("requires system:manage", async () => {
    const key = createTestApiKey({ scopes: ["build:read"] });
    const res = await request(app).get("/api/v1/system").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(403);
  });

  it("returns version and queue status", async () => {
    const key = createTestApiKey({ scopes: ["system:manage"] });
    const res = await request(app).get("/api/v1/system").set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("activeBuild");
    expect(res.body).toHaveProperty("queuedBuilds");
    // No GITHUB_REPO set in the test env — degrades gracefully.
    expect(res.body.checked).toBe(false);
  });
});

describe("GET /api/v1/system/logs", () => {
  it("requires system:manage", async () => {
    const key = createTestApiKey({ scopes: ["build:read"] });
    const res = await request(app).get("/api/v1/system/logs").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(403);
  });

  it("returns a list of log entries", async () => {
    const key = createTestApiKey({ scopes: ["system:manage"] });
    const res = await request(app).get("/api/v1/system/logs").set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });
});

describe("POST /api/v1/system/update", () => {
  it("requires system:manage", async () => {
    const key = createTestApiKey({ scopes: ["build:read"] });
    const res = await request(app).post("/api/v1/system/update").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(403);
  });

  it("refuses when HOST_PROJECT_DIR/API_IMAGE aren't set (not a Compose deployment)", async () => {
    const key = createTestApiKey({ scopes: ["system:manage"] });
    const res = await request(app).post("/api/v1/system/update").set("Authorization", `Bearer ${key}`);

    // The test environment never sets HOST_PROJECT_DIR/API_IMAGE, so this
    // exercises the real refusal path rather than actually spawning a
    // container — triggering a real redeploy has no place in a test run.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/HOST_PROJECT_DIR/);
  });
});

describe("POST /api/v1/system/backup", () => {
  it("requires system:manage", async () => {
    const key = createTestApiKey({ scopes: ["build:read"] });
    const res = await request(app).post("/api/v1/system/backup").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(403);
  });

  // Windows' bsdtar interprets a "C:\..." path's drive-letter colon as a
  // remote-host spec ("tar (child): Cannot connect to C: resolve failed"),
  // the same quirk already documented for scripts/backup.mjs's manual
  // testing — real Linux (this suite's CI target) doesn't have it, and it
  // was independently verified working end to end on a real Linux
  // container. Skipped on Windows dev machines only, not on CI.
  it.skipIf(process.platform === "win32")("creates a real backup archive", async () => {
    const key = createTestApiKey({ scopes: ["system:manage"] });
    const res = await request(app).post("/api/v1/system/backup").set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(201);
    expect(res.body.archivePath).toMatch(/build-server-v.*\.tar\.gz$/);
    expect(existsSync(res.body.archivePath)).toBe(true);

    rmSync(dirname(res.body.archivePath), { recursive: true, force: true });
  });
});

describe("buildUpdateRunnerArgs", () => {
  it("constructs the expected docker run invocation", () => {
    const args = buildUpdateRunnerArgs({
      hostProjectDir: "/home/deploy/build-server",
      apiImage: "build-server-api:latest",
      targetRef: "v1.2.3",
      runnerName: "build-server-update-123",
    });

    expect(args).toEqual([
      "run", "--rm", "-d",
      "--name", "build-server-update-123",
      "--network", "host",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", "/home/deploy/build-server:/home/deploy/build-server",
      "-w", "/home/deploy/build-server",
      "build-server-api:latest",
      "bash", "scripts/update.sh", "v1.2.3",
    ]);
  });

  it("omits the target ref when updating to latest", () => {
    const args = buildUpdateRunnerArgs({
      hostProjectDir: "/home/deploy/build-server",
      apiImage: "build-server-api:latest",
      runnerName: "build-server-update-456",
    });

    expect(args.at(-1)).toBe("scripts/update.sh");
  });

  it("throws when required config is missing", () => {
    expect(() => buildUpdateRunnerArgs({ runnerName: "x" })).toThrow(/HOST_PROJECT_DIR/);
  });
});
