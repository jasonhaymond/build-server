export default {
  id: "0004_artifacts_and_scopes",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        build_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        type TEXT,
        size INTEGER,
        created_at TEXT NOT NULL,
        download_token_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      ALTER TABLE api_keys ADD COLUMN scopes TEXT;
    `);
  },
};
