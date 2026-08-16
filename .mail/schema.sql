-- Inpriv Mail — D1 schema
-- Messages stored as AES-256-GCM envelopes encrypted with MAIL_ENC_KEY
-- (server secret). Transport: TLS. Sessions: bearer tokens (sha256-at-rest).

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  address      TEXT NOT NULL UNIQUE,
  auth_hash    TEXT NOT NULL,               -- PBKDF2-SHA256, 100k iters
  auth_salt    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_login   INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,             -- sha256(token)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ua          TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder      TEXT NOT NULL DEFAULT 'inbox',
  from_addr   TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  subject_enc TEXT NOT NULL,                -- {"iv":"…","ct":"…"} AES-GCM(MAIL_ENC_KEY)
  body_enc    TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER,
  received_at INTEGER,
  external_id TEXT                          -- resend message id for sent mail
);

CREATE TABLE IF NOT EXISTS send_log (
  user_id TEXT NOT NULL,
  bucket  INTEGER NOT NULL,                 -- hour bucket
  c       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_messages_user_folder ON messages(user_id, folder);
CREATE INDEX IF NOT EXISTS idx_messages_sort_inbox  ON messages(user_id, folder, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sort_sent   ON messages(user_id, folder, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
