-- Inpriv Host — D1 schema
-- Privacy notes:
--   * NO IP addresses or user agents are ever stored (rate limiting uses
--     hashed IP prefixes in rl_counters with short bucket windows).
--   * files.drive_file_id stores only the Drive UUID — the original
--     filename never leaves this database.
--   * sessions.id stores SHA-256 of the bearer token, never the token.

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,          -- uuid (also the Drive file name)
  user_id        TEXT NOT NULL,             -- Inpriv ID user id
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,      -- public URL id (host.inpriv.xyz/f/<slug>)
  size           INTEGER NOT NULL,
  mime           TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private',   -- 'private' | 'public'
  scan_status    TEXT NOT NULL DEFAULT 'pending',   -- 'pending'|'skip'|'published'|'blocked'
  scan_summary   TEXT,
  scan_findings  TEXT,                      -- JSON array (blocked uploads only)
  drive_file_id  TEXT,                      -- Google Drive file id (null until published)
  hits           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_slug ON files(slug);

CREATE TABLE IF NOT EXISTS chunks (
  file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (file_id, seq)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,            -- sha256(bearer token)
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- rate-limit counters (from Inpriv ID lib.js — short-lived buckets)
CREATE TABLE IF NOT EXISTS rl_counters (
  k      TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c      INTEGER NOT NULL,
  PRIMARY KEY (k, bucket)
);
