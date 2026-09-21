import { createHash, randomBytes } from "node:crypto";
import { createApiKey } from "../src/db/database.mjs";

export function createTestApiKey({ name = "test-key", scopes } = {}) {
  const key = `abs_test_${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");

  createApiKey({
    name,
    keyHash,
    createdAt: new Date().toISOString(),
    scopes: scopes ? scopes.join(",") : null,
  });

  return key;
}

// Source path doesn't need to exist for most tests — the worker fails
// fast validating it, which is fine when the test only cares about the
// API's own request handling, not the build actually succeeding.
export function sampleJob(overrides = {}) {
  return {
    project: {
      name: "TestProject",
      source: { type: "directory", path: "/nonexistent" },
    },
    build: {
      platform: "android",
      variant: "debug",
      artifact: "apk",
    },
    ...overrides,
  };
}
