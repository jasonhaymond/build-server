import { describe, expect, it } from "vitest";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  validatePasswordLength,
  verifyPassword,
} from "../src/security/passwords.mjs";

describe("validatePasswordLength", () => {
  it("rejects passwords shorter than the minimum", () => {
    expect(validatePasswordLength("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
  });

  it("accepts passwords at or above the minimum", () => {
    expect(validatePasswordLength("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(validatePasswordLength(undefined)).toBe(false);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("round-trips the correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password entirely", hash)).toBe(false);
  });

  it("never stores the plaintext password in the hash", () => {
    const hash = hashPassword("a-very-identifiable-passphrase");
    expect(hash).not.toContain("a-very-identifiable-passphrase");
  });

  it("produces a different hash each time (random salt)", () => {
    const a = hashPassword("same password every time");
    const b = hashPassword("same password every time");
    expect(a).not.toEqual(b);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(verifyPassword("anything", undefined)).toBe(false);
  });
});
