import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export async function extractZipSafely(zipPath, destination) {
  const zipfile = await new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: false },
      (error, file) => (error ? rejectPromise(error) : resolvePromise(file)),
    );
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      zipfile.on("error", rejectPromise);
      zipfile.on("end", resolvePromise);

      zipfile.on("entry", (entry) => {
        handleEntry(entry).then(
          () => zipfile.readEntry(),
          (error) => rejectPromise(error),
        );
      });

      zipfile.readEntry();

      async function handleEntry(entry) {
        const normalized = entry.fileName.replace(/\\/g, "/");

        if (
          normalized.startsWith("/") ||
          /^[A-Za-z]:\//.test(normalized) ||
          normalized.split("/").includes("..")
        ) {
          throw new Error(`Unsafe ZIP entry path: ${entry.fileName}`);
        }

        // High byte of versionMadeBy is the "host OS" that produced the
        // entry; Unix (3) packs the file mode into the top 16 bits of
        // externalFileAttributes. Only trust it as a symlink check when
        // the entry actually claims to come from a Unix zip writer.
        const isUnixEntry = (entry.versionMadeBy >>> 8) === 3;
        const unixMode = isUnixEntry
          ? (entry.externalFileAttributes >>> 16) & 0xffff
          : 0;

        if ((unixMode & 0xf000) === 0xa000) {
          throw new Error(`Symlink ZIP entries are not allowed: ${entry.fileName}`);
        }

        const entryPath = resolve(destination, normalized);

        if (normalized.endsWith("/")) {
          mkdirSync(entryPath, { recursive: true });
          return;
        }

        mkdirSync(dirname(entryPath), { recursive: true });

        const readStream = await new Promise((resolveStream, rejectStream) => {
          zipfile.openReadStream(entry, (error, stream) =>
            error ? rejectStream(error) : resolveStream(stream),
          );
        });

        await pipeline(readStream, createWriteStream(entryPath));
      }
    });
  } finally {
    zipfile.close();
  }
}
