-- Inpriv Fake — D1 schema (disposable identities backed by real Mail mailboxes)

-- One row per generated identity. The mailbox itself lives in MAIL_DB.users
-- (username = local part). Password seal: AES-256-GCM(FAKE_ENC_KEY).
CREATE TABLE IF NOT EXISTS identities (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,             -- Inpriv ID users.id (string uuid)
  username     TEXT NOT NULL,             -- local part, e.g. emma.hayes482
  address      TEXT NOT NULL,             -- username@inpriv.xyz
  nick         TEXT NOT NULL,             -- display nick (generated)
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  pass_sealed  TEXT NOT NULL,             -- AES-GCM envelope JSON of the password
  ttl_minutes  INTEGER NOT NULL,          -- chosen lifetime
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  burned_at    INTEGER                    -- set on manual burn (purge lag ok)
);

CREATE INDEX IF NOT EXISTS idx_identities_owner    ON identities(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identities_username ON identities(username);
CREATE INDEX IF NOT EXISTS idx_identities_expiry   ON identities(expires_at);

-- Fake-local sessions: token hashed at rest; owner identity denormalised so
-- the hot path never joins against Inpriv ID.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,            -- sha256(token)
  owner_id   TEXT NOT NULL,
  username   TEXT NOT NULL,
  nick       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

CREATE TABLE IF NOT EXISTS rl_counters (
  k      TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, bucket)
);
