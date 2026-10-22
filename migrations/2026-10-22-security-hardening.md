# Migration: security hardening (October 2026)

Every statement below is **additive** (new columns and tables) and is also run
lazily by the Workers on first use (`ensureSchema` in Mail, `ensureClaims` in
`common/addresses.js`, `ensure` in `common/access-log.js`). Applying the SQL
files first is optional but makes the change explicit and reviewable.

| File | Database | What it adds |
|---|---|---|
| `inpriv-mail.sql` | inpriv-mail | `users.key_format`, `users.key_id`, `users.keys_updated_at`, `messages.key_id`, `device_keys.device_id`, `device_keys.label`, `rl_counters.exp`, table `key_challenges` |
| `inpriv-id.sql` | inpriv-id | table `address_claims`, table `app_meta`, `access_log.v`, `rl_counters.exp`, `id_init_tickets.kind` |

SQLite has no `ADD COLUMN IF NOT EXISTS`: a column that already exists makes
that one statement fail with "duplicate column", which is harmless. Run each
statement separately if one fails.

```bash
cd .mail/worker && npx wrangler d1 execute inpriv-mail --remote --file ../../migrations/inpriv-mail.sql
cd .id/worker   && npx wrangler d1 execute inpriv-id   --remote --file ../../migrations/inpriv-id.sql
```

## Data written after deploy (no deletion)

- **Address claims backfill** (`address_claims`, owner + local part + day):
  every Inpriv ID username, every retired username and the team mailboxes on the
  first registration or Temp inbox after deploy; every live Temp inbox and every
  Temp address still in the access log on the first hourly Temp cron; every
  Mail username on the first daily Mail cron. Flags in `app_meta` keep the
  one-time parts from repeating.
- **`rl_counters` rows without `exp`** are deleted on the first cleanup run.
  They are short-lived counters; deleting them only resets rate limits.

## Deletions after deploy

- New access-log rows (`v = 2`) are deleted after 30 days.
- Rows written before deploy (`v IS NULL`) keep their original 90-day deletion.
- With the secret `ACCESS_LOG_MINIMIZE=1` on the Temp (and/or Mail) Worker, old
  rows are rewritten to the minimal form (network, browser family, no
  recipient), 500 per cleanup run. **Only set it after confirming no
  preservation request covers the access log.**
  `cd .temp/worker && npx wrangler secret put ACCESS_LOG_MINIMIZE`
- Expired sessions, sign-in tickets, pending 2FA logins and verification codes
  in inpriv-id are now deleted by the cleanup (they used to stay).

## Per-user key upgrade (format 1 → 2)

Happens in the browser when each person next opens Mail, never in bulk. The
server accepts it once per mailbox (compare-and-swap on the old public key) and
only with a proof made with the old private key. The old private key moves into
the new key ring; the copy sealed under the sign-in password is overwritten.

## Rollback

- **Code:** redeploy the previous commit only if no mailbox has been upgraded:
  `SELECT COUNT(*) FROM users WHERE key_format = 2` on inpriv-mail must be 0.
  After that, the previous Mail page can't open format-2 key rings, so roll
  forward instead.
- **Data:** D1 Time Travel restores a database to a point in time (7 days on the
  Free plan): `npx wrangler d1 time-travel restore <db> --timestamp <ISO time>`.
  Restoring inpriv-mail to before an upgrade brings back that mailbox's
  password-sealed key, so it's a last resort.
- The added columns and tables can stay after a code rollback; the old code
  ignores them.
