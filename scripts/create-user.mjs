#!/usr/bin/env node

// Bootstraps the very first admin account. Refuses once any user exists
// — every account after this one is created through an invite issued by
// an existing admin (the web UI's admin Users panel), not this script.
//
// Reads prompts via the readline interface's own async iterator rather
// than rl.question() — question()'s once('line')-per-call pairing can
// silently drop/misalign answers when multiple lines are already
// buffered on piped/non-TTY stdin before the next question() call
// registers its listener (confirmed on Node 24; see scripts/setup.mjs,
// which had the same latent bug and is fixed the same way).

import readline from "node:readline";
import { countUsers, createUser } from "../src/db/database.mjs";
import { hashPassword, MIN_PASSWORD_LENGTH, validatePasswordLength } from "../src/security/passwords.mjs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();

async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? "" : value;
}

if (countUsers() > 0) {
  console.error("A user account already exists — this script only bootstraps the first admin.");
  console.error("Create additional accounts by inviting them from the admin Users panel instead.");
  rl.close();
  process.exit(1);
}

console.log("");
console.log("=== build-server: create the first admin account ===");
console.log("");

const username = (await ask("Username: ")).trim();

if (!username) {
  console.error("Username is required.");
  rl.close();
  process.exit(1);
}

let password = "";

while (!validatePasswordLength(password)) {
  password = (await ask(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `)).trim();

  if (!validatePasswordLength(password)) {
    console.log(`Too short — needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

createUser({
  username,
  passwordHash: hashPassword(password),
  role: "admin",
  createdAt: new Date().toISOString(),
});

console.log("");
console.log(`Admin account created: ${username}`);
console.log("");
console.log("Two-factor authentication is mandatory — the first sign-in at the web");
console.log("UI's login page will walk through TOTP enrollment (scan a QR code with");
console.log("an authenticator app) before a session is issued.");
console.log("");

rl.close();
