export default {
  id: "0006_users_and_auth",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS user_recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id),
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      -- purpose='signup': role/suggested_username are set, target_user_id
      -- is null (the account doesn't exist yet). purpose='password_reset':
      -- target_user_id identifies the existing account, role/
      -- suggested_username are null.
      CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT UNIQUE NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'password_reset')),
        role TEXT CHECK (role IN ('admin', 'user')),
        suggested_username TEXT,
        target_user_id INTEGER REFERENCES users(id),
        signup_request_id INTEGER,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS signup_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_username TEXT NOT NULL,
        email TEXT,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        ip_address TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by INTEGER REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_reads (
        notification_id INTEGER NOT NULL REFERENCES notifications(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        read_at TEXT NOT NULL,
        PRIMARY KEY (notification_id, user_id)
      );

      -- Ownership moves from api_key_id to user_id (see security/scopes.mjs
      -- and server.mjs's requireBuildAccess). Both stay nullable so
      -- pre-upgrade builds/keys keep working exactly as before, unowned.
      ALTER TABLE builds ADD COLUMN user_id INTEGER;
      ALTER TABLE api_keys ADD COLUMN user_id INTEGER;
    `);
  },
};
