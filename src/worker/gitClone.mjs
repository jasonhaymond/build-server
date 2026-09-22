import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Clones a git source into `destination`. When `ref` is given, always goes
// through init+remote+fetch+checkout rather than `git clone --branch <ref>`
// — `--branch` only accepts a branch/tag name, not an arbitrary commit SHA,
// and pinning to a commit SHA (a CI pipeline's own `${{ github.sha }}`, for
// instance) is a completely normal thing to do, not an edge case. Fetching
// by ref works uniformly for a branch, a tag, or a raw SHA, so there's no
// need to guess which kind of ref this is. Confirmed directly: `--branch
// <sha>` fails with "Remote branch <sha> not found in upstream origin"
// even though the commit is perfectly reachable.
export function cloneGitSource({ url, ref, auth, destination, askpassDir }) {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  let askpassPath;

  // Credentials are handed to git via GIT_ASKPASS rather than embedded in
  // the clone URL — the URL (which IS logged, and IS visible in argv/`ps`)
  // must never contain the token. The askpass script only ever reads it
  // from an env var and prints it to git directly over a private pipe.
  if (auth) {
    askpassPath = resolve(askpassDir, "git-askpass.sh");
    writeFileSync(
      askpassPath,
      "#!/bin/sh\ncase \"$1\" in\n  Username*) printf '%s' \"$BUILD_SERVER_GIT_ASKPASS_USERNAME\" ;;\n  Password*) printf '%s' \"$BUILD_SERVER_GIT_ASKPASS_TOKEN\" ;;\nesac\n",
      { mode: 0o700 },
    );
    gitEnv.GIT_ASKPASS = askpassPath;
    gitEnv.BUILD_SERVER_GIT_ASKPASS_USERNAME = "x-access-token";
    gitEnv.BUILD_SERVER_GIT_ASKPASS_TOKEN = auth.token;
  }

  function runGit(args, options = {}) {
    execFileSync("git", args, { stdio: ["ignore", "inherit", "inherit"], env: gitEnv, ...options });
  }

  try {
    if (ref) {
      mkdirSync(destination, { recursive: true });
      runGit(["init", destination]);
      runGit(["remote", "add", "origin", url], { cwd: destination });
      runGit(["fetch", "--depth", "1", "origin", ref], { cwd: destination });
      runGit(["checkout", "FETCH_HEAD"], { cwd: destination });
    } else {
      runGit(["clone", "--depth", "1", url, destination]);
    }
  } finally {
    if (askpassPath && existsSync(askpassPath)) {
      rmSync(askpassPath, { force: true });
    }
  }
}
