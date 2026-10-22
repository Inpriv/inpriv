# Inpriv Temp — Disposable Email

> Random `@inpriv.xyz` addresses that live for 24 hours. No signup.

> **Not end-to-end encrypted.** Incoming messages are stored as plain text in the
> Worker's database — see [Security model](#security-model) for what that means.

Part of [Inpriv](https://inpriv.xyz) by [Inpriv Labs](https://inpriv.xyz).

**Live:** <https://temp.inpriv.xyz>

## What it does

Generates a random disposable email address (e.g. `ember-otter-k7m2q@inpriv.xyz`)
on page load. Incoming mail lands in the inbox within seconds — live polling,
sandboxed HTML viewer, plain-text tab, downloadable attachments. One click on
**Shred** deletes the inbox and every message instantly. Mailboxes expire
automatically after 24 h (hourly cron sweeps them away). An address is claimed for
good when it's created (`common/addresses.js`): it's never handed to anyone else.

You can also pick a custom local part (new inboxes are limited per network: 20 an hour, 5 of them custom).
Outbound mail is disabled.

## Security model

**Temp is not end-to-end encrypted, and doesn't pretend to be.** Incoming bodies and
attachments are fetched from Resend and stored as **plain text** in D1. What actually
protects a mailbox:

- **Unguessable addresses** — two words and five random characters (about 74 billion
  names); a live mailbox cannot be found without knowing its exact address (no enumeration: the inbound webhook returns
  200 for unknown recipients without storing anything).
- **Bearer token, scoped per mailbox** — the inbox is readable only with the token the
  browser got at creation; only its SHA-256 hash is stored server-side.
- **Short life** — 24 h mailbox TTL, 7 d message hard cap, hourly cron sweep, one-click
  Shred (deletes the inbox and every message immediately; the address stays retired).
- **Sandboxed HTML viewer** — HTML is stripped of active content on arrival, rebuilt by an
  allowlist sanitizer in the browser and shown in a script-less sandboxed iframe with its
  own CSP. Remote images load only after "Load images"; a plain-text tab is always there.
- **Never reused** — expired and deleted addresses stay claimed, so mail for an earlier
  holder (password resets…) can't reach a new one. Creating an inbox isn't logged.
- **Hardened webhook** — svix/Standard Webhooks HMAC-SHA256 signature verification with
  timestamp tolerance; reserved local parts (`admin`, `postmaster`, …) can never be
  claimed.

In practice: the operator (or whoever compromises the Worker/D1) can read mail while it
exists. Use Temp for sign-ups and verifications, not for secrets — for confidential
mail use [Mail](https://mail.inpriv.xyz), which encrypts internal mail end-to-end.

## Architecture

```
sender ──SMTP──▶ Resend Receiving (MX: inbound-smtp.eu-west-1.amazonaws.com)
                     │ webhook `email.received` (svix-signed)
                     ▼
        Cloudflare Worker  temp.inpriv.xyz/api/inbound
                     │  verify svix HMAC-SHA256 signature
                     │  fetch body via Received emails API*
                     ▼
                 D1 (inpriv-temp)  ◀── GET /api/messages (bearer token)
                     ▲                          │
   browser (single-file UI) ───────────────────┘
```

\* Webhooks deliver metadata only. Bodies and attachments are fetched through
`GET /emails/receiving/{id}` and `/attachments` — this needs a **read-capable**
API key. With only a send-restricted key, messages are still stored with
subject/sender/attachment list; the body is omitted.

- **Transport in:** Resend Receiving (custom domain, catch-all `*@inpriv.xyz`)
- **App:** Cloudflare Worker + D1, static assets binding
- **Transport out:** Resend send API
- **Storage:** D1, bearer-token scoped per mailbox, 24 h TTL, 7 d hard cap
- **Security:** svix (Standard Webhooks) signature verification with
  timestamp-tolerance window; token hashes at rest; sandboxed iframe viewer;
  reserved local parts (`admin`, `postmaster`, …) can never be claimed

## Setup

```bash
cd worker
npx wrangler d1 execute inpriv-temp --remote --file schema.sql
npx wrangler secret put RESEND_API_KEY          # send access (outbound)
npx wrangler secret put RESEND_READ_API_KEY     # read access (inbound bodies)
npx wrangler secret put RESEND_WEBHOOK_SECRET   # whsec_… from Resend dashboard
npx wrangler deploy
```

In the Resend dashboard create a webhook: endpoint
`https://temp.inpriv.xyz/api/inbound`, event `email.received`; copy the shown
signing secret into `RESEND_WEBHOOK_SECRET`.

The domain must have Resend's inbound MX record (`feedback-smtp.eu-west-1.amazonaws.com`,
prio 10) — already configured for `inpriv.xyz`.

## Tests

```bash
cd worker && npm test    # svix verification vs official Standard Webhooks vectors
```

## Limits

| | |
|---|---|
| Mailbox lifetime | 24 h |
| Message retention | 7 d |
| Message body | 100k chars text / 300k HTML |
| Attachments stored | ≤512 KB each, ≤2 MB per message |
| Outbound | 10 messages/hour/mailbox |

## License

MIT — see [LICENSE](../LICENSE).
