import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// crypto.scrypt rather than a bcrypt dependency — same "hand-roll with
// node:crypto" approach already used for AES-GCM in secrets.mjs, no
// native module to build/ship for this.
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export const MIN_PASSWORD_LENGTH = 12;

export function validatePasswordLength(password) {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split(":");

  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length, SCRYPT_PARAMS);

  return timingSafeEqual(actual, expected);
}
