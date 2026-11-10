-- "Suggest my address to others" (off by default). An address may be offered
-- in someone's composer only when both this and show_address are on, so a
-- switch can only loosen what the other forbids.
ALTER TABLE users ADD COLUMN suggest_address INTEGER NOT NULL DEFAULT 0;
