import { describe, expect, it } from "vitest";
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from "../src/security/totp.mjs";

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

describe("generateTotpSecret / buildOtpauthUri", () => {
  it("generates a base32 secret of the standard 160-bit length", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("generates a different secret each time", () => {
    expect(generateTotpSecret()).not.toEqual(generateTotpSecret());
  });

  it("builds a well-formed otpauth:// URI", () => {
    const uri = buildOtpauthUri("ABCDEFGHIJKLMNOP", "jason", "build-server");
    expect(uri).toBe(
      "otpauth://totp/build-server:jason?secret=ABCDEFGHIJKLMNOP&issuer=build-server&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("verifyTotpCode", () => {
  // RFC 6238 Appendix B's own test vector: ASCII secret
  // "12345678901234567890", at Unix time 59 (counter=1) the 8-digit TOTP
  // is 94287082 — our 6-digit truncation is the same value mod 10^6.
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  it("matches the RFC 6238 reference test vector", () => {
    const realNow = Date.now;
    Date.now = () => 59 * 1000;

    try {
      expect(verifyTotpCode(rfcSecret, "287082", { window: 0 })).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects a wrong code at that same reference time", () => {
    const realNow = Date.now;
    Date.now = () => 59 * 1000;

    try {
      expect(verifyTotpCode(rfcSecret, "000000", { window: 0 })).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects malformed input instead of throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(verifyTotpCode(secret, undefined)).toBe(false);
  });

  it("accepts a code from one step earlier within the window", () => {
    const realNow = Date.now;
    // Same counter (1) as the RFC vector, but "now" is one step later
    // (counter=2) — should still verify with the default window of 1.
    Date.now = () => 89 * 1000;

    try {
      expect(verifyTotpCode(rfcSecret, "287082", { window: 1 })).toBe(true);
      expect(verifyTotpCode(rfcSecret, "287082", { window: 0 })).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("generateRecoveryCodes / hashRecoveryCode", () => {
  it("generates the requested number of unique codes", () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    codes.forEach((code) => expect(code).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/));
  });

  it("hashes consistently regardless of case/whitespace", () => {
    const hash = hashRecoveryCode("abcde-12345");
    expect(hashRecoveryCode("ABCDE-12345")).toBe(hash);
    expect(hashRecoveryCode("  abcde-12345  ")).toBe(hash);
  });

  it("never stores the plaintext code in the hash", () => {
    expect(hashRecoveryCode("abcde-12345")).not.toContain("abcde-12345");
  });
});
