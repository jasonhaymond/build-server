export default {
  id: "0005_app_meta",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
