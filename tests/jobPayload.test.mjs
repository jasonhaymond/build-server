import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deserializeJobFromQueue,
  serializeJobForQueue,
  serializeJobMasked,
} from "../src/queue/jobPayload.mjs";

describe("job payload — project.source.auth handling", () => {
  const key = randomBytes(32).toString("hex");

  const job = {
    id: "bld_test",
    project: {
      name: "Example",
      source: {
        type: "git",
        url: "https://github.com/example/project.git",
        auth: { type: "token", token: "ghp_verysecrettoken" },
      },
    },
    build: { platform: "android", variant: "release", artifact: "apk", secrets: { API_KEY: "shh" } },
  };

  it("encrypts source.auth (and build.secrets) at rest, never in plaintext", () => {
    const serialized = serializeJobForQueue(job, key);

    expect(serialized).not.toContain("ghp_verysecrettoken");
    expect(serialized).not.toContain("shh");
  });

  it("round-trips source.auth (and build.secrets) back to plaintext", () => {
    const serialized = serializeJobForQueue(job, key);
    const restored = deserializeJobFromQueue(serialized, key);

    expect(restored.project.source.auth).toEqual({ type: "token", token: "ghp_verysecrettoken" });
    expect(restored.build.secrets).toEqual({ API_KEY: "shh" });
  });

  it("masks source.auth (and build.secrets) with *** once a build starts", () => {
    const masked = JSON.parse(serializeJobMasked(job));

    expect(masked.project.source.auth).toEqual({ type: "***", token: "***" });
    expect(masked.build.secrets).toEqual({ API_KEY: "***" });
  });

  it("leaves project.source untouched when there is no auth", () => {
    const noAuthJob = { ...job, project: { name: "Example", source: { type: "git", url: "https://github.com/example/project.git" } } };

    const serialized = serializeJobForQueue(noAuthJob, key);
    const restored = deserializeJobFromQueue(serialized, key);

    expect(restored.project.source.auth).toBeUndefined();
  });
});
