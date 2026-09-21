#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createApiKey } from "../src/db/database.mjs";
import { KNOWN_SCOPES, serializeScopes } from "../src/security/scopes.mjs";

const args = process.argv.slice(2);
const scopesFlagIndex = args.indexOf("--scopes");

let name;
let scopes = null;

if (scopesFlagIndex !== -1) {
  scopes = args[scopesFlagIndex + 1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  name = args.filter((_, index) => index !== scopesFlagIndex && index !== scopesFlagIndex + 1)[0];
} else {
  name = args[0];
}

if (!name) {
  console.error("Usage: node scripts/create-api-key.mjs <name> [--scopes scope1,scope2,...]");
  console.error(`Known scopes: ${KNOWN_SCOPES.join(", ")}`);
  console.error("Omit --scopes for full access (all current and future scopes).");
  process.exit(1);
}

if (scopes) {
  const unknown = scopes.filter((scope) => !KNOWN_SCOPES.includes(scope));

  if (unknown.length > 0) {
    console.error(`Unknown scope(s): ${unknown.join(", ")}`);
    console.error(`Known scopes: ${KNOWN_SCOPES.join(", ")}`);
    process.exit(1);
  }
}

const key = `abs_${randomBytes(32).toString("hex")}`;

const keyHash = createHash("sha256")
  .update(key)
  .digest("hex");

createApiKey({
  name,
  keyHash,
  createdAt: new Date().toISOString(),
  scopes: serializeScopes(scopes),
});

console.log("");
console.log(`API key created for: ${name}`);
console.log(`Scopes: ${scopes ? scopes.join(", ") : "full access"}`);
console.log("");
console.log(key);
console.log("");
console.log("IMPORTANT: Save this key now.");
console.log("The server stores only a hash of the key.");
console.log("");
