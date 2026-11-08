-- Existing authenticators and recovery codes remain valid.
ALTER TABLE totp_secrets ADD COLUMN last_step INTEGER;
ALTER TABLE users ADD COLUMN pending_recovery_email TEXT;
