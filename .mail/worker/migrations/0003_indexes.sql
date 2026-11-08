CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_key_challenges_expires_at ON key_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_rl_counters_exp ON rl_counters(exp);
CREATE INDEX IF NOT EXISTS idx_messages_owner_created ON messages(owner_id, created_at DESC, id DESC);
