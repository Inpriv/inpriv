-- Inpriv ID — D1 schema
-- Central account system for all Inpriv services (id.inpriv.xyz).
--
-- Security model:
--  - Password: PBKDF2-SHA256, 310 000 iterations (OWASP 2023), per-user salt.
--  - Sessions: opaque bearer tokens; only sha256(token) is stored.
--  - TOTP 2FA: RFC 6238, SHA-1, 6 digits, ±1 step window. Secret stored
--    AES-256-GCM encrypted with ID_ENC_KEY (server secret).
--  - Recovery codes: 10 single-use codes, sha256 at rest.
--  - Vault: per-user encrypted blob (nickname, avatar seed, preferences).
--  - Email verification: 6-digit codes, sha256 at rest, 15-min TTL.

CREATE TABLE IF NOT EXISTS users (
  id                      TEXT PRIMARY KEY,
  username                TEXT UNIQUE,
  email                   TEXT NOT NULL UNIQUE,
  recovery_email          TEXT,
  nick                    TEXT,
  pass_hash               TEXT NOT NULL,
  pass_salt               TEXT NOT NULL,
  pass_iters              INTEGER NOT NULL DEFAULT 310000,
  email_verified          INTEGER NOT NULL DEFAULT 0,
  recovery_email_verified INTEGER NOT NULL DEFAULT 0,
  totp_enabled            INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  last_login              INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  ip_prefix    TEXT,
  created_at   INTEGER NOT NULL,
  last_used    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  totp_ok      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc  TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER
);

CREATE TABLE IF NOT EXISTS email_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'verify',
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS vault (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blob_enc   TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service    TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  last_used  INTEGER,
  PRIMARY KEY (user_id, service)
);

CREATE TABLE IF NOT EXISTS auth_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ip_prefix  TEXT,
  ula        TEXT,
  at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_2fa (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_prefix  TEXT
);

CREATE TABLE IF NOT EXISTS rl_counters (
  k      TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  c      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, bucket)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user         ON auth_events(user_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username  ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_recovery_email ON users(recovery_email);


-- ── Quick Sign-In (SSO) ─────────────────────────────────────────────────────
-- One-time tickets that let a signed-in browser mint a session on another
-- *.inpriv.xyz service without retyping the master password. Minted by id.js
-- (cookie-authenticated), redeemed server-to-server by the target service
-- backend with the shared SERVICE_KEY.
CREATE TABLE IF NOT EXISTS service_grants (
  id           TEXT PRIMARY KEY,             -- random ticket id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service      TEXT NOT NULL,                -- "mail" | "host" | "keyring" | …
  state        TEXT NOT NULL,                -- browser nonce, echoed back
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,             -- 120 s single-use window
  used_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_grants_user ON service_grants(user_id, created_at);

-- ── Account settings (Quick Unlock master-password bypass & future flags) ──
CREATE TABLE IF NOT EXISTS user_settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quick_unlock  INTEGER NOT NULL DEFAULT 1,  -- 0 = always require master password
  updated_at    INTEGER NOT NULL
);

-- Encrypted device-key blobs for the master-password bypass. The page wraps
-- its local DEK under the user's RSA public key; the server only ever stores
-- the opaque ciphertext (one blob per user, replaced on every device that
-- re-enrols).
CREATE TABLE IF NOT EXISTS quick_unlock (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
