import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecrets, encryptSecrets, maskSecretsObject } from "../src/security/secrets.mjs";

describe("encryptSecrets / decryptSecrets", () => {
  const key = randomBytes(32).toString("hex");

  it("round-trips a secrets object", () => {
    const secrets = { API_KEY: "value-with-spaces and $ymbols!" };
    const encrypted = encryptSecrets(secrets, key);

    expect(JSON.stringify(encrypted)).not.toContain("value-with-spaces");
    expect(decryptSecrets(encrypted, key)).toEqual(secrets);
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptSecrets({ FOO: "bar" }, key);
    const wrongKey = randomBytes(32).toString("hex");

    expect(() => decryptSecrets(encrypted, wrongKey)).toThrow();
  });

  it("rejects a malformed key", () => {
    expect(() => encryptSecrets({}, "too-short")).toThrow(/32-byte/);
    expect(() => encryptSecrets({}, undefined)).toThrow(/not set/);
  });
});

describe("maskSecretsObject", () => {
  it("replaces every value with ***", () => {
    expect(maskSecretsObject({ A: "1", B: "2" })).toEqual({ A: "***", B: "***" });
  });

  it("passes through null/undefined", () => {
    expect(maskSecretsObject(undefined)).toBeUndefined();
  });
});
