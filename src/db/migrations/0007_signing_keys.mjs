// Android signing keys, one row per key, owned by exactly one user (see
// src/security/signingKeys.mjs for how they're generated, encrypted and used).
// - name: the user's own label, unique per user ("clocker"); builds refer to it by name.
// - key_alias / store_type / cert_sha256: non-secret facts shown in the web UI —
//   cert_sha256 is the certificate fingerprint Android compares for updates.
// - secret_payload column: holds the keystore together with its passwords, encrypted
//   (AES-256-GCM) using the server's job-secrets key. Never returned by the API.
// Additive only: a new table, nothing existing changes.
export default {
  id: "0007_signing_keys",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signing_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        key_alias TEXT NOT NULL,
        store_type TEXT NOT NULL,
        cert_sha256 TEXT NOT NULL,
        secret_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
    `);
  },
};
