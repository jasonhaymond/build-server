import { createWriteStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { extractZipSafely } from "../src/worker/zip.mjs";

function buildZip(entries) {
  return new Promise((resolvePromise, rejectPromise) => {
    const zipfile = new yazl.ZipFile();

    for (const entry of entries) {
      zipfile.addBuffer(Buffer.from(entry.content ?? ""), entry.path, {
        mode: entry.mode,
      });
    }

    zipfile.end();

    const dir = mkdtempSync(join(tmpdir(), "build-server-zip-test-"));
    const zipPath = join(dir, "test.zip");
    const stream = createWriteStream(zipPath);

    stream.on("close", () => resolvePromise(zipPath));
    stream.on("error", rejectPromise);

    zipfile.outputStream.pipe(stream);
  });
}

describe("extractZipSafely", () => {
  it("extracts a normal archive's files and directories", async () => {
    const zipPath = await buildZip([
      { path: "normal.txt", content: "hello" },
      { path: "subdir/nested.txt", content: "nested" },
    ]);

    const destDir = mkdtempSync(join(tmpdir(), "build-server-zip-out-"));
    await extractZipSafely(zipPath, destDir);

    expect(readFileSync(join(destDir, "normal.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(destDir, "subdir", "nested.txt"), "utf8")).toBe("nested");
  });

  it("rejects a symlink entry", async () => {
    const symlinkMode = 0xa1ff; // S_IFLNK | 0777
    const zipPath = await buildZip([
      { path: "normal.txt", content: "hello" },
      { path: "evil-link", content: "/etc/passwd", mode: symlinkMode },
    ]);

    const destDir = mkdtempSync(join(tmpdir(), "build-server-zip-out-"));

    await expect(extractZipSafely(zipPath, destDir)).rejects.toThrow(/[Ss]ymlink/);
  });
});
