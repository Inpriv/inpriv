-- A sender the account has blocked. Mail from them is dropped in the inbound
-- handler and sending to them is refused. Blocking is per account and goes
-- away with it (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS blocked_senders (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, address)
);
CREATE INDEX IF NOT EXISTS idx_blocked_senders_user ON blocked_senders(user_id);

-- 1 when the sender asked not to be named: the recipient's copy stores
-- "Anonymous Inpriv user" as the label and the client must not show the
-- address, not even in a title attribute.
ALTER TABLE messages ADD COLUMN peer_masked INTEGER NOT NULL DEFAULT 0;
