-- Inpriv Mail — D1 schema
-- Message bodies are stored as RSA-OAEP-wrapped AES-GCM envelopes. Private
-- keys are stored only inside a key ring sealed in the browser with a key from
-- the mailbox passphrase (key_format 2), which the server never receives.
-- key_format 1 (before October 2026): one private key sealed under the Inpriv
-- ID password; upgraded in the browser on next use. auth_hash/auth_salt: copy
-- of the password hash for mailboxes from before Inpriv ID ('' otherwise).

CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  username               TEXT NOT NULL UNIQUE,
  address                TEXT NOT NULL UNIQUE,   -- username@inpriv.xyz
  auth_hash              TEXT NOT NULL,
  auth_salt              TEXT NOT NULL,
  public_key             TEXT NOT NULL,          -- b64 SPKI RSA-2048 (current key)
  key_id                 TEXT,                   -- first 128 bits of sha256(SPKI), hex
  key_format             INTEGER NOT NULL DEFAULT 1,
  keys_updated_at        INTEGER,
  encrypted_private_key  TEXT NOT NULL,          -- b64 sealed key ring (format 2)
  priv_iv                TEXT NOT NULL,
  priv_salt              TEXT NOT NULL,
  priv_iter              INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  last_login             INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                  -- sha256(token)
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ua          TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL,               -- inbound | outbound
  peer_address      TEXT NOT NULL,
  peer_label        TEXT,
  subject           TEXT,                        -- metadata only
  encrypted_aes_key TEXT NOT NULL,               -- RSA-OAEP(user pubkey, AES key)
  iv                TEXT NOT NULL,
  ciphertext        TEXT NOT NULL,               -- AES-GCM ct (tag split off)
  auth_tag          TEXT NOT NULL,
  key_id            TEXT,                        -- key the envelope was made for (hint)
  is_read           INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rl_counters (
  k      TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c      INTEGER NOT NULL DEFAULT 0,
  exp    INTEGER,                                -- deleted by the daily cron after this
  PRIMARY KEY (k, bucket)
);

-- One-time proofs that the browser holds the current private key
CREATE TABLE IF NOT EXISTS key_challenges (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer_hash TEXT NOT NULL,
  purpose     TEXT NOT NULL,                     -- migrate | rewrap | device
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_id, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);

-- "Skip mailbox passphrase" device keys. The browser wraps the passphrase key
-- under a random device key kept in its storage and stores only the wrap here.
CREATE TABLE IF NOT EXISTS device_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT,
  label       TEXT,                              -- browser family · system
  wrapped_dek TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_device_keys_dev ON device_keys(user_id, device_id);
