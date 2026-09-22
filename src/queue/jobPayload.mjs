import { decryptSecrets, encryptSecrets, maskSecretsObject } from "../security/secrets.mjs";

// project.source.auth (a git credential, when present) gets exactly the same
// treatment as build.secrets below — encrypted at rest while queued, masked
// the instant the build starts, never persisted in plaintext.
function projectWithEncryptedAuth(project, keyHex) {
  if (!project?.source?.auth) {
    return project;
  }

  return {
    ...project,
    source: {
      ...project.source,
      auth: { encrypted: encryptSecrets(project.source.auth, keyHex) },
    },
  };
}

function projectWithMaskedAuth(project) {
  if (!project?.source?.auth) {
    return project;
  }

  return {
    ...project,
    source: { ...project.source, auth: maskSecretsObject(project.source.auth) },
  };
}

// Persisted so a genuinely queued build survives an API restart. Env vars
// are plaintext; secrets are encrypted at rest with JOB_SECRETS_ENCRYPTION_KEY
// so they're never persisted in plaintext, only ever decrypted in memory.
export function serializeJobForQueue(job, keyHex) {
  return JSON.stringify({
    ...job,
    project: projectWithEncryptedAuth(job.project, keyHex),
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
    project: projectWithMaskedAuth(job.project),
    build: job.build
      ? { ...job.build, secrets: maskSecretsObject(job.build.secrets) }
      : job.build,
  });
}

export function deserializeJobFromQueue(jobPayloadJson, keyHex) {
  const parsed = JSON.parse(jobPayloadJson);
  const encryptedSecrets = parsed.build?.secrets?.encrypted;
  const encryptedAuth = parsed.project?.source?.auth?.encrypted;

  if (encryptedSecrets) {
    parsed.build.secrets = decryptSecrets(encryptedSecrets, keyHex);
  }

  if (encryptedAuth) {
    parsed.project.source.auth = decryptSecrets(encryptedAuth, keyHex);
  }

  return parsed;
}
