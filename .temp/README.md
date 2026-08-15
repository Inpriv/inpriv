# Inpriv Temp 📮

> A random disposable email address, the moment you open the page.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by
[Aurex Labs](https://aurexlabs.xyz). Live at **[temp.inpriv.xyz](https://temp.inpriv.xyz)**.

## What it does

Open the page and you instantly get a random address like
`ember-falcon-482@inpriv.xyz`. Anything sent to it lands in the page within
seconds — verification codes, signup confirmations, one-time links — and you
can read it right in the browser. **Delete** shreds the inbox and every stored
message with one click and hands you a fresh address. Nothing to sign up for,
nothing to leak.

## How it works

```
sender ──SMTP──▶ Cloudflare Email Routing (catch-all *@inpriv.xyz)
                        │
                        ▼
              Worker email() handler  ──reject──▶ unknown/expired mailbox bounces
                        │ parse (postal-mime)
                        ▼
                D1 (messages + mailboxes)
                        ▲
        browser ◀──API──┘   bearer mailbox token (sha256 at rest)
```

- **No accounts.** A mailbox is a random local part plus a 128-bit bearer
  token that lives in your browser's localStorage. The token's SHA-256 hash is
  the only thing stored server-side — the API refuses to show a mailbox's
  messages to anyone without it.
- **Bounce for strangers.** Mail to addresses that were never generated (or
  that expired) is rejected at the edge with a proper `550` — junk is never
  stored.
- **Self-destruct.** Every mailbox expires 24 h after creation; an hourly cron
  sweeps expired mailboxes, their messages, and anything older than 7 days.
- **One-click delete.** `DELETE /api/mailbox` removes the mailbox and all of
  its messages immediately, then the UI mints a fresh address.
- **Outbound.** *Send email* sends from your temp address through the
  **Resend** API (`RESEND_API_KEY` secret, restricted send-only key),
  rate-limited to 10 sends/hour per mailbox.
- **Safe rendering.** HTML bodies render inside a `sandbox`ed iframe — no
  scripts, no same-origin access. Attachments up to 512 KB each (2 MB per
  message) are stored and downloadable; larger ones are listed but not kept.

## Stack

Cloudflare Worker (single `src/index.js`) · Email Routing catch-all · D1
database `inpriv-temp` (schema in `schema.sql`) · postal-mime · Resend ·
vanilla HTML/CSS/JS frontend, Material Design 3 (earthy forest) — same look
as the rest of the suite.

## Deploy / operate

```bash
cd worker
npm install
npx wrangler d1 execute inpriv-temp --remote --file schema.sql   # first time only
echo "re_…" | npx wrangler secret put RESEND_API_KEY             # first time only
npx wrangler deploy
```

Email Routing must be enabled on `inpriv.xyz` with a **catch-all → Send to
Worker → `temp`** rule (already live):

```bash
npx wrangler email routing enable inpriv.xyz
npx wrangler email routing rules list inpriv.xyz
```

## Privacy

- No telemetry, no logs beyond error diagnostics.
- Message bodies are stored in D1 only until the mailbox expires, is deleted,
  or 7 days pass — whichever comes first.
- Rendering HTML mail loads remote images (that's how email works); if you
  need pixel-proof viewing, use the *Plain text* tab.
