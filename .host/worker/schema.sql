-- Inpriv Host — D1 schema
-- Privacy notes:
--   * NO IP addresses or user agents are ever stored (rate limiting uses
--     hashed IP prefixes in rl_counters with short bucket windows).
--   * files.drive_file_id stores only the Drive UUID — the original
--     filename never leaves this database.
--   * sessions.id stores SHA-256 of the bearer token, never the token.

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,          -- uuid (also the Drive file name)
  user_id        TEXT NOT NULL,             -- Inpriv ID user id, or 'guest:<prefix>' for anonymous uploads
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,      -- public URL id (host.inpriv.xyz/f/<slug>)
  custom_slug    TEXT,                      -- custom URL id (host.inpriv.xyz/s/<custom>) — signed-in owners
  size           INTEGER NOT NULL,
  mime           TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private',   -- 'private' | 'public'
  scan_status    TEXT NOT NULL DEFAULT 'pending',   -- 'pending'|'skip'|'published'|'blocked'
  scan_summary   TEXT,
  scan_findings  TEXT,                      -- JSON array (blocked uploads only)
  drive_file_id  TEXT,                      -- Google Drive file id (null until published)
  expires_at     INTEGER,                   -- guest uploads: auto-delete after 7 days
  manage_token   TEXT,                      -- guest uploads: sha256(manage key) for delete-by-key
  hits           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_slug ON files(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_custom ON files(custom_slug) WHERE custom_slug IS NOT NULL;

-- per-account limits (storage quota raises approved by the operator)
CREATE TABLE IF NOT EXISTS account_limits (
  user_id        TEXT PRIMARY KEY,
  max_file_bytes INTEGER,
  quota_bytes    INTEGER                         -- storage quota; default = 1 GB when NULL
);

-- limit-increase requests (reason text arrives encrypted — see limit_requests.reason_enc)
CREATE TABLE IF NOT EXISTS limit_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  contact       TEXT NOT NULL,
  current_mb    INTEGER,
  requested_mb  INTEGER NOT NULL,
  reason_enc    TEXT,                       -- JSON envelope { encrypted_aes_key, iv, ciphertext, auth_tag }
  created_at    INTEGER NOT NULL
);

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
