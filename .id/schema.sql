-- Inpriv ID — D1 schema
-- Central account system for all Inpriv services (id.inpriv.xyz).
--
-- Security model:
--  - Password: PBKDF2-SHA256, 300 000 chained iterations, per-user salt.
--  - Sessions: opaque bearer tokens; only sha256(token) is stored.
--  - TOTP 2FA: RFC 6238, SHA-1, 6 digits, ±1 step window. Secret stored
--    AES-256-GCM encrypted with ID_ENC_KEY (server secret).
--  - Recovery codes: 10 single-use codes, protected with AES-GCM at rest.
--  - Vault: per-user encrypted blob (nickname, avatar seed, preferences).
--  - Email verification: 6-digit codes, protected with AES-GCM at rest, 15-min TTL.

CREATE TABLE IF NOT EXISTS users (
  id                      TEXT PRIMARY KEY,
  username                TEXT UNIQUE,
  email                   TEXT NOT NULL UNIQUE,
  recovery_email          TEXT,
  pending_recovery_email  TEXT,
  nick                    TEXT,
  pass_hash               TEXT NOT NULL,
  pass_salt               TEXT NOT NULL,
  pass_iters              INTEGER NOT NULL DEFAULT 300000,
  email_verified          INTEGER NOT NULL DEFAULT 0,
  recovery_email_verified INTEGER NOT NULL DEFAULT 0,
  totp_enabled            INTEGER NOT NULL DEFAULT 0,
  show_address            INTEGER NOT NULL DEFAULT 0,  -- 0 = "Anonymous Inpriv user"
  suggest_address         INTEGER NOT NULL DEFAULT 0,  -- 0 = never offered in someone else's composer
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
  last_step   INTEGER,
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
  exp    INTEGER,                    -- deleted by the hourly cleanup after this
  PRIMARY KEY (k, bucket)
);

-- Who holds each @inpriv.xyz local part (common/addresses.js). Never deleted,
-- so an address is never issued twice.
CREATE TABLE IF NOT EXISTS address_claims (
  local      TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,          -- id | temp | team
  claimed_on TEXT NOT NULL           -- YYYY-MM-DD
);
CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT);

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

CREATE TABLE IF NOT EXISTS retired_usernames (username TEXT PRIMARY KEY, retired_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER);
CREATE TABLE IF NOT EXISTS id_init_tickets (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, kind TEXT);
CREATE INDEX IF NOT EXISTS idx_iit_username ON id_init_tickets(username, created_at);
CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, service TEXT NOT NULL, event TEXT NOT NULL, account TEXT, detail TEXT, ip TEXT, country TEXT, asn INTEGER, ua TEXT, v INTEGER);
CREATE INDEX IF NOT EXISTS idx_access_account ON access_log(account, at);
CREATE INDEX IF NOT EXISTS idx_access_ip ON access_log(ip, at);
CREATE INDEX IF NOT EXISTS idx_access_at ON access_log(at);


CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires_at ON pending_2fa(expires_at);
CREATE INDEX IF NOT EXISTS idx_service_grants_expires_at ON service_grants(expires_at);
CREATE INDEX IF NOT EXISTS idx_id_init_tickets_expires_at ON id_init_tickets(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_codes_expires_at ON email_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_codes_user_id_purpose_code_hash ON email_codes(user_id, purpose, code_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id_code_hash ON recovery_codes(user_id, code_hash);
CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);
CREATE INDEX IF NOT EXISTS idx_rl_counters_exp ON rl_counters(exp);
CREATE INDEX IF NOT EXISTS idx_admin_kv_exp ON admin_kv(exp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_recovery_email_uq ON users(recovery_email) WHERE recovery_email IS NOT NULL;
