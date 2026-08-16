-- Inpriv ID — D1 schema
-- Central account system for all Inpriv services (account.inpriv.xyz).
--
-- Security model:
--  - Password: PBKDF2-SHA256, 310 000 iterations (OWASP 2023), per-user salt.
--  - Sessions: opaque bearer tokens; only sha256(token) is stored.
--  - TOTP 2FA: RFC 6238, SHA-1, 6 digits, ±1 step window. Secret stored
--    AES-256-GCM encrypted with ID_ENC_KEY (server secret).
--  - Recovery codes: 10 single-use codes, sha256 at rest.
--  - Vault: per-user encrypted blob (nickname, avatar seed, preferences).
--  - Email verification: 6-digit codes, sha256 at rest, 15-min TTL.

CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  nick             TEXT,
  pass_hash        TEXT NOT NULL,
  pass_salt        TEXT NOT NULL,
  pass_iters       INTEGER NOT NULL DEFAULT 310000,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  totp_enabled     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_login       INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  ip_prefix    TEXT,
  created_at   INTEGER NOT NULL,
  last_used    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  totp_ok      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc  TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER
);

CREATE TABLE IF NOT EXISTS email_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'verify',
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS vault (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blob_enc   TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service    TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  last_used  INTEGER,
  PRIMARY KEY (user_id, service)
);

CREATE TABLE IF NOT EXISTS auth_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ip_prefix  TEXT,
  ula        TEXT,
  at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_2fa (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_prefix  TEXT
);

CREATE TABLE IF NOT EXISTS rl_counters (
  k      TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, bucket)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user   ON auth_events(user_id, at);
CREATE INDEX IF NOT EXISTS idx_codes_user    ON email_codes(user_id, purpose);
