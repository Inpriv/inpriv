-- Security hardening, October 2026 (see 2026-10-22-security-hardening.md).
-- Additive only. "duplicate column" on a re-run is harmless.
CREATE TABLE IF NOT EXISTS address_claims (
  local      TEXT PRIMARY KEY,   -- lowercase local part of an @inpriv.xyz address
  owner      TEXT NOT NULL,      -- 'id' | 'temp' | 'team'
  claimed_on TEXT NOT NULL       -- YYYY-MM-DD
);
CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT);
ALTER TABLE access_log ADD COLUMN v INTEGER;
ALTER TABLE rl_counters ADD COLUMN exp INTEGER;
ALTER TABLE id_init_tickets ADD COLUMN kind TEXT;
