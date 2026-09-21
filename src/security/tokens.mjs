import { createHash, randomBytes } from "node:crypto";

export function createArtifactToken() {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}
