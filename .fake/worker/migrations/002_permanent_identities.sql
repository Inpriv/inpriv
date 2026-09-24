-- Migration 002: allow NULL expires_at for permanent ("Never") identities.
-- Safe at this revision because identities table is empty (verified 2026-09-24).
-- If you ever re-run this against a non-empty DB, wrap in a transaction and
-- copy data back in the same atomic step.

CREATE TABLE identities_new (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  username     TEXT NOT NULL,
  address      TEXT NOT NULL,
  nick         TEXT NOT NULL,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  pass_sealed  TEXT NOT NULL,
  ttl_minutes  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                   -- NULL = permanent identity (manual burn only)
  burned_at    INTEGER
);
INSERT INTO identities_new SELECT * FROM identities;
DROP TABLE identities;
ALTER TABLE identities_new RENAME TO identities;
CREATE INDEX IF NOT EXISTS idx_identities_owner    ON identities(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identities_username ON identities(username);
CREATE INDEX IF NOT EXISTS idx_identities_expiry   ON identities(expires_at);
