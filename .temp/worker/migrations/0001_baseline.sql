-- Inpriv Temp — D1 schema for disposable mailboxes
-- Mailboxes are address-scoped: the bearer token (sha256-at-rest) is the only
-- way to read a mailbox's messages. Everything expires after 24 h (cron).

CREATE TABLE IF NOT EXISTS mailboxes (
  address    TEXT PRIMARY KEY,          -- full lowercase address, e.g. ember-fox-123@inpriv.xyz
  token_hash TEXT NOT NULL UNIQUE,      -- sha256(hex) of the client bearer token
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  mailbox      TEXT NOT NULL,           -- FK mailboxes.address (deleted manually)
  from_addr    TEXT NOT NULL,
  from_name    TEXT,
  to_addr      TEXT NOT NULL,
  subject      TEXT,
  text         TEXT,                    -- plain-text body (capped)
  html         TEXT,                    -- html body (capped, rendered in a sandboxed iframe)
  att_count    INTEGER NOT NULL DEFAULT 0,
  attachments  TEXT,                    -- JSON [{filename,contentType,size,data?|dropped}] capped
  size         INTEGER NOT NULL DEFAULT 0,
  message_id   TEXT,
  received_at  INTEGER NOT NULL,
  read         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, received_at DESC);

CREATE TABLE IF NOT EXISTS sends (
  mailbox    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sends_mailbox_at ON sends(mailbox, at DESC);
