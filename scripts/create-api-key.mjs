#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createApiKey } from "../src/db/database.mjs";

const name = process.argv[2];

if (!name) {
  console.error("Usage: node scripts/create-api-key.mjs <name>");
  process.exit(1);
}

const key = `abs_${randomBytes(32).toString("hex")}`;

const keyHash = createHash("sha256")
  .update(key)
  .digest("hex");

createApiKey({
  name,
  keyHash,
  createdAt: new Date().toISOString(),
});

console.log("");
console.log(`API key created for: ${name}`);
console.log("");
console.log(key);
console.log("");
console.log("IMPORTANT: Save this key now.");
console.log("The server stores only a hash of the key.");
console.log("");
