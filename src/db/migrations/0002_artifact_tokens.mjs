export default {
  id: "0002_artifact_tokens",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_download_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        build_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        created_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
  },
};
