-- Inpriv Mail — D1 schema (zero-knowledge internal mail)
-- The server stores only RSA-OAEP-wrapped AES envelopes; plaintext never
-- leaves the browser. Passwords: PBKDF2-SHA256 verifier (3×100k chained).

CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  username               TEXT NOT NULL UNIQUE,
  address                TEXT NOT NULL UNIQUE,   -- username@inpriv.xyz
  auth_hash              TEXT NOT NULL,
  auth_salt              TEXT NOT NULL,
  public_key             TEXT NOT NULL,          -- b64 SPKI RSA-2048
  encrypted_private_key  TEXT NOT NULL,          -- b64 wrapped pkcs8
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
  is_read           INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rl_counters (
  k      TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, bucket)
);

CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_id, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);

-- Quick Unlock device keys (master-password bypass, opt-in per account on
-- id.inpriv.xyz). The browser wraps its local AES DEK under a random device
-- key (kept in localStorage) and stores only the wrapped DEK here, encrypted
-- end-to-end; the server cannot decrypt anything. Quick Sign-In sessions
-- present their session token to read it back.
CREATE TABLE IF NOT EXISTS device_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_dek TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id);
