# Changelog

## 9 November 2026

- Load older Mail in pages of 200 messages, including messages with matching timestamps.
- Require the current mailbox key before replacing it, and a fresh second factor for sensitive account changes when two-factor authentication is on.
- Reject reused authenticator codes across ID and Mail; protect verification and recovery codes at rest while keeping existing recovery codes usable.
- Confirm recovery-email ownership before binding a new address, enforce database uniqueness, and limit verification emails per destination.
- Remove an account's security and access-log entries when the account is deleted; use network prefixes for Temp creation counters.
- Apply shared sending budgets to external account and operator mail. External account mail requires a confirmed recovery email.
- Retain maintenance locks when the control panel is unreachable; keep operator messages in the authenticated panel.
- Add additive D1 migrations, expiry and pagination indexes, CI before deployment, shared server helpers, linting, and checks for all shared UI copies.

Recovery, aliases, attachments, threads, server-side search, passkeys, and push delivery are not part of this release. Compatibility dates remain unchanged pending testing in isolated staging resources. Existing security-event tables use explicit deletion rather than a table rebuild to add a foreign key.
