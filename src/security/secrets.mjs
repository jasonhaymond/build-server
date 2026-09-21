import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyFromHex(keyHex) {
  if (!keyHex) {
    throw new Error(
      "JOB_SECRETS_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  const key = Buffer.from(keyHex, "hex");

  if (key.length !== 32) {
    throw new Error(
      "JOB_SECRETS_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters.",
    );
  }

  return key;
}

export function encryptSecrets(secrets, keyHex) {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(JSON.stringify(secrets ?? {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecrets(payload, keyHex) {
  if (!payload) {
    return {};
  }

  const key = keyFromHex(keyHex);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, "base64"),
  );

  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8"));
}

// Used for the human-readable job.json / job_payload masking, not for the
// restart-durable encrypted form above.
export function maskSecretsObject(secrets) {
  if (!secrets) {
    return secrets;
  }

  return Object.fromEntries(
    Object.keys(secrets).map((name) => [name, "***"]),
  );
}
