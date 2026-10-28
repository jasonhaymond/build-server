// Android signing keys: generating and inspecting keystores, and encrypting them for storage.
//
// A signing key proves an APK/AAB came from its owner — Android only installs an update
// over an existing app if both are signed with the same key. That makes these the most
// sensitive thing build-server holds: anyone who can sign with your key can publish
// "updates" to your app. So:
//   - The keystore and its passwords are encrypted at rest with JOB_SECRETS_ENCRYPTION_KEY
//     (AES-256-GCM, same as job secrets — see ./secrets.mjs) and only ever decrypted in
//     memory by the API (once, to show a newly generated key for backup) or by the worker
//     (during a build that's allowed to use it).
//   - keytool (Java's key tool) runs inside the existing Android build image in a
//     throwaway container — the API image has no Java. Passwords reach keytool only via a
//     0600 file it reads (`-storepass:file`), never on a command line or in an environment
//     variable, where other processes on the host could see them.
//   - Nothing here is ever logged.
// Called from src/api/server.mjs (POST /api/v1/signing-keys) and src/worker/index.mjs.

import { execFile } from "node:child_process";
import { chownSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveBuildContainerIds, resolveHostBuildDir } from "../worker/docker.mjs";
import { decryptSecrets, encryptSecrets } from "./secrets.mjs";

const execFileAsync = promisify(execFile);

// Key names users choose ("clocker", "homebase-upload"): lowercase letters, digits and
// dashes, starting with a letter or digit, max 64 chars. Regex example: "clocker-2026"
// matches; "Clocker", "../x" and "a b" don't. Kept this strict because the name also
// appears in the web UI and build requests.
export const SIGNING_KEY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Same rule for the key alias inside the keystore (keytool allows more, but a plain alias
// avoids quoting issues anywhere it's used).
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function dockerImage() {
  return process.env.ANDROID_BUILD_IMAGE ?? "build-server-android:latest";
}

// Runs `keytool <args>` in a throwaway build-image container with `workDir` (a fresh,
// private directory under builds/) mounted at /k. Same isolation flags as a real build
// (non-root user, no network, no new privileges). Returns keytool's stdout. Throws with
// keytool's own message on failure (never includes the password — it's only in a file).
async function runKeytool(serverDir, workDirName, args) {
  const { uid, gid } = resolveBuildContainerIds();
  const hostDir = resolveHostBuildDir(serverDir, workDirName);
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run", "--rm",
        "--network", "none",
        "--user", `${uid}:${gid}`,
        "--security-opt", "no-new-privileges",
        "--memory", "1g",
        "-v", `${hostDir}:/k`,
        "--entrypoint", "keytool",
        dockerImage(),
        ...args,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`keytool failed: ${detail}`);
  }
}

// Creates a private scratch directory under builds/ (the one directory already mapped for
// Docker — see ../worker/docker.mjs), for one keytool run. The caller deletes it in a
// finally block. When the API runs as root (Docker-outside-of-Docker), the directory is
// handed to the build container's non-root user so keytool can write into it; otherwise
// it already belongs to us.
function makeScratchDir(serverDir) {
  const name = `_signing-${randomBytes(8).toString("hex")}`;
  const dir = resolve(serverDir, "builds", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) {
    const { uid, gid } = resolveBuildContainerIds();
    chownSync(dir, Number(uid), Number(gid));
  }
  return { name, dir };
}

// Writes one private (0600) file into a scratch directory — a password, or an uploaded
// keystore — owned by the build container's user when we're root, same reason as
// makeScratchDir. Only that user can read it; it's deleted with the directory.
function writePrivateFile(dir, fileName, data) {
  const path = resolve(dir, fileName);
  writeFileSync(path, data, { mode: 0o600 });
  if (process.getuid?.() === 0) {
    const { uid, gid } = resolveBuildContainerIds();
    chownSync(path, Number(uid), Number(gid));
  }
}

// Parses `keytool -list -v` output for what build-server records about a key: its
// keystore type, alias, and the certificate's SHA-256 fingerprint (the public identity
// Android compares when deciding whether an update may install — safe to show anyone).
// Example line matched: "SHA256: AB:CD:…:EF".
function parseKeytoolList(output) {
  const sha = output.match(/SHA256:\s*([0-9A-F:]{95})/i)?.[1];
  const storeType = output.match(/Keystore type:\s*(\S+)/i)?.[1]?.toLowerCase();
  const alias = output.match(/Alias name:\s*(\S+)/i)?.[1];
  if (!sha || !alias) throw new Error("Couldn't read the key's certificate from keytool's output.");
  return { certSha256: sha.toUpperCase(), storeType: storeType === "jks" ? "jks" : "pkcs12", alias };
}

// Generates a brand-new 4096-bit RSA signing key, valid ~27 years (Google Play requires
// validity past 2033), in a PKCS12 keystore with one random 32-byte password (PKCS12
// uses one password for both the store and the key). `commonName` becomes the
// certificate's "CN=" — informational only. Returns the keystore bytes and everything
// needed to use it; the caller encrypts it for storage and shows it once.
export async function generateSigningKeystore({ serverDir, alias, commonName }) {
  if (!ALIAS_PATTERN.test(alias)) throw new Error("Invalid key alias.");
  // CN text goes into keytool's -dname; strip characters with meaning in a DN.
  const cn = String(commonName || alias).replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 64) || alias;
  const password = randomBytes(24).toString("base64url");
  const { name, dir } = makeScratchDir(serverDir);
  try {
    writePrivateFile(dir, "pw", password);
    await runKeytool(serverDir, name, [
      "-genkeypair", "-storetype", "PKCS12", "-keystore", "/k/key.p12",
      "-alias", alias, "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000",
      "-dname", `CN=${cn}`,
      "-storepass:file", "/k/pw", "-keypass:file", "/k/pw",
    ]);
    const keystore = readFileSync(resolve(dir, "key.p12"));
    const listing = await runKeytool(serverDir, name, ["-list", "-v", "-keystore", "/k/key.p12", "-storepass:file", "/k/pw"]);
    const info = parseKeytoolList(listing);
    return { keystore, storePassword: password, keyPassword: password, keyAlias: alias, ...info };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Checks an uploaded keystore actually opens with the given password and contains the
// given alias, and reads its certificate fingerprint. Throws a user-facing message if
// not (wrong password, wrong alias, not a keystore). The key password is checked too by
// asking keytool to export the certificate with it.
export async function inspectUploadedKeystore({ serverDir, keystore, storePassword, keyAlias, keyPassword }) {
  if (!ALIAS_PATTERN.test(keyAlias)) throw new Error("Invalid key alias.");
  const { name, dir } = makeScratchDir(serverDir);
  try {
    writePrivateFile(dir, "ks", keystore);
    writePrivateFile(dir, "spw", storePassword);
    writePrivateFile(dir, "kpw", keyPassword);
    let listing;
    try {
      listing = await runKeytool(serverDir, name, ["-list", "-v", "-keystore", "/k/ks", "-alias", keyAlias, "-storepass:file", "/k/spw"]);
    } catch {
      throw new Error("Couldn't open that keystore with the given password and alias.");
    }
    const info = parseKeytoolList(listing);
    if (info.storeType === "jks") {
      // JKS keys can have their own password; prove it's right so a build doesn't fail later.
      try {
        await runKeytool(serverDir, name, [
          "-keypasswd", "-keystore", "/k/ks", "-alias", keyAlias,
          "-storepass:file", "/k/spw", "-keypass:file", "/k/kpw", "-new:file", "/k/kpw",
        ]);
      } catch {
        throw new Error("The key password is wrong for that alias.");
      }
    }
    return { ...info, keyAlias };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What's stored in the signing_keys.secret_payload column: the keystore (base64) and both
// passwords, encrypted together as one AES-256-GCM blob. Never returned by any API route.
export function encryptSigningMaterial({ keystore, storePassword, keyPassword }, keyHex) {
  return JSON.stringify(
    encryptSecrets({ keystoreBase64: Buffer.from(keystore).toString("base64"), storePassword, keyPassword }, keyHex),
  );
}

// Reverses encryptSigningMaterial. Only the worker (during an allowed build) calls this.
export function decryptSigningMaterial(secretPayload, keyHex) {
  const { keystoreBase64, storePassword, keyPassword } = decryptSecrets(JSON.parse(secretPayload), keyHex);
  return { keystore: Buffer.from(keystoreBase64, "base64"), storePassword, keyPassword };
}
