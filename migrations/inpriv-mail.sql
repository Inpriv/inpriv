-- Security hardening, October 2026 (see 2026-10-22-security-hardening.md).
-- Additive only. "duplicate column" on a re-run is harmless.
ALTER TABLE users ADD COLUMN key_format INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN key_id TEXT;
ALTER TABLE users ADD COLUMN keys_updated_at INTEGER;
ALTER TABLE messages ADD COLUMN key_id TEXT;
ALTER TABLE device_keys ADD COLUMN device_id TEXT;
ALTER TABLE device_keys ADD COLUMN label TEXT;
ALTER TABLE rl_counters ADD COLUMN exp INTEGER;
CREATE INDEX IF NOT EXISTS idx_device_keys_dev ON device_keys(user_id, device_id);
CREATE TABLE IF NOT EXISTS key_challenges (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer_hash TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
