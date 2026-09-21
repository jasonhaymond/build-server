import { statSync } from "node:fs";
import { createArtifactDownloadToken, createArtifactRecord } from "../db/database.mjs";
import { createArtifactToken } from "../security/tokens.mjs";

// Registers an artifact + its permanent download token at build time,
// rather than the API lazily creating a token on first listing request —
// makes the artifacts table the source of truth instead of a directory scan.
export function registerArtifact({ buildId, filename, type, path }) {
  const size = statSync(path).size;
  const createdAt = new Date().toISOString();
  const token = createArtifactToken();

  const tokenResult = createArtifactDownloadToken({
    tokenHash: token,
    buildId,
    filename,
    createdAt,
  });

  createArtifactRecord({
    buildId,
    filename,
    type,
    size,
    createdAt,
    downloadTokenId: tokenResult.lastInsertRowid,
  });

  return { size, token };
}
