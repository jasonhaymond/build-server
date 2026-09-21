import { decryptSecrets, encryptSecrets, maskSecretsObject } from "../security/secrets.mjs";

// Persisted so a genuinely queued build survives an API restart. Env vars
// are plaintext; secrets are encrypted at rest with JOB_SECRETS_ENCRYPTION_KEY
// so they're never persisted in plaintext, only ever decrypted in memory.
export function serializeJobForQueue(job, keyHex) {
  return JSON.stringify({
    ...job,
    build: job.build
      ? {
          ...job.build,
          secrets: job.build.secrets
            ? { encrypted: encryptSecrets(job.build.secrets, keyHex) }
            : undefined,
        }
      : job.build,
  });
}

// Once a build starts, the encrypted form has served its purpose — replace
// it with the same human-readable `***` masking already used for job.json.
export function serializeJobMasked(job) {
  return JSON.stringify({
    ...job,
    build: job.build
      ? { ...job.build, secrets: maskSecretsObject(job.build.secrets) }
      : job.build,
  });
}

export function deserializeJobFromQueue(jobPayloadJson, keyHex) {
  const parsed = JSON.parse(jobPayloadJson);
  const encrypted = parsed.build?.secrets?.encrypted;

  if (encrypted) {
    parsed.build.secrets = decryptSecrets(encrypted, keyHex);
  }

  return parsed;
}
