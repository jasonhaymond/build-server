export default {
  id: "0003_queue_recovery",
  up(db) {
    db.exec(`
      ALTER TABLE builds ADD COLUMN job_payload TEXT;
      ALTER TABLE builds ADD COLUMN platform TEXT;
      ALTER TABLE builds ADD COLUMN variant TEXT;
      ALTER TABLE builds ADD COLUMN artifact_type TEXT;
      ALTER TABLE builds ADD COLUMN duration_ms INTEGER;
      ALTER TABLE builds ADD COLUMN worker TEXT;
      ALTER TABLE builds ADD COLUMN failure_reason TEXT;
      ALTER TABLE builds ADD COLUMN cancellation_state TEXT;
      ALTER TABLE builds ADD COLUMN submitted_by TEXT;
      ALTER TABLE builds ADD COLUMN api_key_id INTEGER;
    `);
  },
};
