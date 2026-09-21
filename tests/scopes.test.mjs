import { describe, expect, it } from "vitest";
import { hasScope, parseScopes, serializeScopes } from "../src/security/scopes.mjs";

describe("scopes", () => {
  it("serializes and parses a scope list", () => {
    const serialized = serializeScopes(["build:create", "build:read"]);
    expect(serialized).toBe("build:create,build:read");
    expect(parseScopes(serialized)).toEqual(["build:create", "build:read"]);
  });

  it("treats an empty/undefined scope list as null (full access)", () => {
    expect(serializeScopes(undefined)).toBeNull();
    expect(serializeScopes([])).toBeNull();
    expect(parseScopes(null)).toBeNull();
  });

  it("a key with no recorded scopes has every scope (legacy full access)", () => {
    expect(hasScope({ scopes: null }, "build:cancel")).toBe(true);
  });

  it("a scoped key only has the scopes it was granted", () => {
    const key = { scopes: ["build:read"] };
    expect(hasScope(key, "build:read")).toBe(true);
    expect(hasScope(key, "build:cancel")).toBe(false);
  });
});
