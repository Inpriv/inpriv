-- "Show my address to people I write to" (off by default). The mail worker
-- reads this when it stores a message, so the setting has to live here and not
-- in the client-encrypted vault.
ALTER TABLE users ADD COLUMN show_address INTEGER NOT NULL DEFAULT 0;
