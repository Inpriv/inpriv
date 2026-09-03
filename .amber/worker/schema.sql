-- Inpriv Amber — schema (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,               -- normalized origin+path (no scheme shown in UI)
  host TEXT NOT NULL,              -- lowercased hostname (for grouping/search)
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, host, url)
);
CREATE INDEX IF NOT EXISTS idx_sites_user  ON sites (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sites_host  ON sites (user_id, host, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,             -- 12-char public id
  site_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  drive_file_id TEXT,              -- NULL until the ZIP lands on Drive
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- queued|ok|failed
  error TEXT,
  pages INTEGER NOT NULL DEFAULT 1,
  assets INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  final_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snaps_site ON snapshots (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snaps_user ON snapshots (user_id, created_at DESC);

-- URL → in-zip path map for captured pages (nav links during viewing)
CREATE TABLE IF NOT EXISTS snap_pages (
  snap_id TEXT NOT NULL,
  url TEXT NOT NULL,               -- normalized origin+path+query
  path TEXT NOT NULL,              -- path inside the ZIP
  PRIMARY KEY (snap_id, url)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,             -- sha256(token)
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  nick TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rl_counters (
  k TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c INTEGER NOT NULL,
  PRIMARY KEY (k, bucket)
);
