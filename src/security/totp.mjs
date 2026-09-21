// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) hand-rolled with
// node:crypto rather than a library — the same approach this project
// already uses for AES-GCM (secrets.mjs) and password hashing
// (passwords.mjs). No dependency needed for ~40 lines of well-specified
// math; the only new dependency this feature adds is `qrcode`, purely to
// render the enrollment QR image.
import { createHash, createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);

    if (index === -1) {
      continue;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return binary % 10 ** DIGITS;
}

export function generateTotpSecret() {
  // 160 bits — the standard size for SHA1-based TOTP secrets.
  return base32Encode(randomBytes(20));
}

export function buildOtpauthUri(secretBase32, username, issuer = "build-server") {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;

  return (
    `otpauth://totp/${label}?secret=${secretBase32}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
  );
}

// window=1 tolerates the previous/next 30s step, per the standard's own
// recommendation for clock drift between the server and the user's phone.
export function verifyTotpCode(secretBase32, code, { window = 1 } = {}) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return false;
  }

  const secretBuffer = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const expectedCode = Number(code);

  for (let delta = -window; delta <= window; delta += 1) {
    if (hotp(secretBuffer, counter + delta) === expectedCode) {
      return true;
    }
  }

  return false;
}

export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(5).toString("hex");
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
}

// Same sha256-of-the-secret pattern as artifact download tokens
// (security/tokens.mjs) — only the hash is ever stored at rest.
export function hashRecoveryCode(code) {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}
