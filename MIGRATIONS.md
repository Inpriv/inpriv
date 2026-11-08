# D1 migrations

Each database's migrations live in its owning Worker's `migrations/` directory. Cross-database bindings reference the same directory; apply a database's migrations once, from its owner:

| Database | Owner directory |
| --- | --- |
| inpriv-id | .id/worker |
| inpriv-mail | .mail/worker |
| inpriv-temp | .temp/worker |
| inpriv-status | .status/worker |

Use Wrangler 4.83.0. `0001_baseline.sql` establishes the already deployed tables without replacing them. ID's `0002_second_factor.sql` adds the accepted authenticator step and pending recovery-email address. `0003_indexes.sql` adds lookup, expiry and uniqueness indexes. Apply them locally first with `npx wrangler@4.83.0 d1 migrations apply <database> --local`.

Before remote application, verify the maintenance lock, run `PRAGMA foreign_key_check` and `PRAGMA quick_check`, and check for duplicate recovery-email groups without displaying addresses. Remote D1 rejects `PRAGMA integrity_check` with `SQLITE_AUTH`; the local SQLite migration tests run it. Never silently delete or unbind duplicate accounts.

The operator-authorized release applies migrations with `npx wrangler@4.83.0 d1 migrations apply <database> --remote` before merging code that needs them. Rerun the checks afterwards. The deploy workflow deliberately does not apply production migrations automatically.

Existing verification and recovery hashes are protected in batches of at most 100 per table on ID health requests using its existing encryption secret. This compatibility step changes only their stored protection, preserves issued codes, and never logs their values. Before ending maintenance, verify the number of unprotected code hashes is zero; repeat health requests if necessary.

Runtime schema helpers are compatibility no-ops. New environments must apply migrations before starting Workers. Existing password-hash iteration values and key formats are not rewritten. Fresh schemas default to the authoritative 300,000-iteration password chain; account code always supplies the iteration count explicitly.

The retired manual tests in `.admin/worker/test/e2e.mjs`, `.admin/worker/test/verify_all.mjs`, and `.mail/worker/test/e2e-inbound.mjs` throw before doing work. Use the local harness instead. Staging must have separate Workers and D1 databases; no staging binding should point at production. Provision and test that environment before changing compatibility dates.
