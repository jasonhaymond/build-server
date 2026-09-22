import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneGitSource } from "../src/worker/gitClone.mjs";

let originDir;
let workDir;
let firstCommitSha;
let secondCommitSha;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeEach(() => {
  originDir = mkdtempSync(join(tmpdir(), "build-server-origin-"));
  workDir = mkdtempSync(join(tmpdir(), "build-server-work-"));

  git(["init", "-q", "-b", "main"], originDir);
  git(["config", "user.email", "test@test.com"], originDir);
  git(["config", "user.name", "Test"], originDir);

  writeFileSync(join(originDir, "file.txt"), "first");
  git(["add", "."], originDir);
  git(["commit", "-q", "-m", "first commit"], originDir);
  firstCommitSha = git(["rev-parse", "HEAD"], originDir);

  git(["tag", "v1"], originDir);

  writeFileSync(join(originDir, "file.txt"), "second");
  git(["add", "."], originDir);
  git(["commit", "-q", "-m", "second commit"], originDir);
  secondCommitSha = git(["rev-parse", "HEAD"], originDir);

  git(["checkout", "-q", "-b", "a-branch"], originDir);
  writeFileSync(join(originDir, "file.txt"), "branch-tip");
  git(["add", "."], originDir);
  git(["commit", "-q", "-m", "branch commit"], originDir);
  git(["checkout", "-q", "main"], originDir);
});

afterEach(() => {
  rmSync(originDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("cloneGitSource", () => {
  it("clones the default branch when no ref is given", () => {
    const destination = join(workDir, "dest");
    cloneGitSource({ url: originDir, destination, askpassDir: workDir });

    expect(readFileSync(join(destination, "file.txt"), "utf8")).toBe("second");
    expect(git(["rev-parse", "HEAD"], destination)).toBe(secondCommitSha);
  });

  it("checks out a branch by name", () => {
    const destination = join(workDir, "dest");
    cloneGitSource({ url: originDir, ref: "a-branch", destination, askpassDir: workDir });

    expect(readFileSync(join(destination, "file.txt"), "utf8")).toBe("branch-tip");
  });

  it("checks out a tag by name", () => {
    const destination = join(workDir, "dest");
    cloneGitSource({ url: originDir, ref: "v1", destination, askpassDir: workDir });

    expect(git(["rev-parse", "HEAD"], destination)).toBe(firstCommitSha);
  });

  // The actual bug: `git clone --branch <ref>` fails on a raw commit SHA
  // (confirmed independently: "Remote branch <sha> not found in upstream
  // origin") even though the exact same SHA fetches and checks out fine.
  // This is the case that broke a real build (a CI pipeline pinning to
  // its own commit SHA, the same pattern docs/integrating-a-project.md
  // recommends).
  it("checks out an exact commit SHA that is NOT the branch tip", () => {
    const destination = join(workDir, "dest");
    cloneGitSource({ url: originDir, ref: firstCommitSha, destination, askpassDir: workDir });

    expect(readFileSync(join(destination, "file.txt"), "utf8")).toBe("first");
    expect(git(["rev-parse", "HEAD"], destination)).toBe(firstCommitSha);
    expect(git(["rev-parse", "HEAD"], destination)).not.toBe(secondCommitSha);
  });

  it("cleans up the askpass script after a successful clone", () => {
    const destination = join(workDir, "dest");
    cloneGitSource({
      url: originDir,
      ref: firstCommitSha,
      auth: { type: "token", token: "irrelevant-for-a-local-repo" },
      destination,
      askpassDir: workDir,
    });

    expect(existsSync(join(workDir, "git-askpass.sh"))).toBe(false);
  });

  it("cleans up the askpass script even when the clone fails", () => {
    const destination = join(workDir, "dest");

    expect(() => cloneGitSource({
      url: originDir,
      ref: "this-ref-does-not-exist",
      auth: { type: "token", token: "irrelevant-for-a-local-repo" },
      destination,
      askpassDir: workDir,
    })).toThrow();

    expect(existsSync(join(workDir, "git-askpass.sh"))).toBe(false);
  });

  it("throws for an unreachable/invalid ref", () => {
    const destination = join(workDir, "dest");

    expect(() => cloneGitSource({
      url: originDir,
      ref: "not-a-real-ref",
      destination,
      askpassDir: workDir,
    })).toThrow();
  });
});
