import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before this test file's own imports resolve, so every test file
// gets its own real, disposable SQLite database and a valid encryption
// key — never the project's actual data/build-server.db.
process.env.JOB_SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("hex");

const tempDir = mkdtempSync(join(tmpdir(), "build-server-test-"));
process.env.DB_PATH = join(tempDir, "test.db");

process.env.PUBLIC_BASE_URL = "http://localhost:8080";
