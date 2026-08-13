# Inpriv Burn 🔥

> Zero-knowledge ephemeral encrypted notes — read once, then gone forever.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Burn lets you create self-destructing encrypted notes. Notes are AES-256-GCM
encrypted entirely in the browser — the server only ever sees ciphertext. The
encryption key lives in the URL fragment (`#id.key`), which is never sent to
the server. Set a TTL (1 minute to 30 days) or enable burn-after-read so the
note is permanently deleted the moment someone opens the link.

## Features

- **Client-side AES-256-GCM encryption** — key never touches the network
- **Burn-after-read** — note is destroyed on first successful GET
- **Configurable TTL** — 60 seconds to 30 days
- **Manual burn** — `DELETE /api/notes/:id` to destroy immediately
- **URL-fragment key delivery** — link format `https://burn.inpriv.xyz/#<id>.<key>`
- **AAD binding** — note ID is used as additional authenticated data, binding
  ciphertext to its identity
- **Zero server-side decryption** — the Worker has no crypto keys; it stores
  opaque blobs in Cloudflare KV with expiration
- **No accounts, no tracking** — fully anonymous

## Architecture

```
┌──────────────┐                 ┌──────────────────────┐
│  Browser     │   POST /api/notes  (id, ciphertext)    │
│  (index.html)│ ─────────────────────────────────────► │
│              │                                        │ Cloudflare
│  Generates   │ ◄───────────────────────────────────── │ Worker
│  id (16B) +  │   GET /api/notes/:id → {ciphertext}     │ + KV
│  key (32B)   │                                        │
│  Encrypts    │   Key stays in URL fragment (#id.key)  │
│  locally     │   ← server never receives the key       │
└──────────────┘                 └──────────────────────┘
```

**Client-side:** The `index.html` / `worker/public/index.html` is a single-file
frontend. It generates a random ID (16 bytes) and key (32 bytes), encrypts the
note with AES-256-GCM using the ID as additional authenticated data (AAD), and
sends only `{id, ciphertext}` to the server. The share link includes the key
in the URL fragment — browsers never send fragments to servers.

**Server-side:** The Cloudflare Worker (`worker/src/index.js`) is a dumb KV
store. It validates ID format, enforces size and TTL limits, and stores/retrieves
opaque JSON blobs (`{c: ciphertext, b: burnAfterRead, t: createdAt}`). It has
no decryption keys and cannot read note contents. KV entries auto-expire via
`expirationTtl`; burn-after-read entries are explicitly deleted on first GET.

## Setup

### Prerequisites
- Node.js 18+ (for Wrangler CLI)
- A Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)

### Environment variables

This service has no server-side environment variables. All configuration is in
`wrangler.toml`. The only setup step is creating the KV namespace and pasting
its ID into the `[[kv_namespaces]]` block.

### Deploy

```bash
cd worker/

# 1. Login to Cloudflare (browser OAuth)
npx wrangler login

# 2. Create the KV namespace
npx wrangler kv namespace create BURN_KV
# → Copy the returned ID into wrangler.toml → [[kv_namespaces]] → id = "..."

# 3. Copy the frontend into the worker's public/ dir
cp ../index.html public/index.html

# 4. Deploy
npx wrangler deploy

# 5. Custom domain (burn.inpriv.xyz) — add via dashboard or:
npx wrangler domains add burn.inpriv.xyz
```

Frontend calls same-origin `/api/notes`, so no CORS config needed once served
by the Worker on the custom domain.

### Worker API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/notes` | Store encrypted blob (`{id, ciphertext, ttlSeconds, burnAfterRead}`) |
| `GET` | `/api/notes/:id` | Fetch blob (destroys it if burn-after-read) |
| `DELETE` | `/api/notes/:id` | Manual burn |
| `OPTIONS` | `*` | CORS preflight |

## Security

- **True zero-knowledge:** The encryption key is generated client-side and
  delivered via URL fragment. The Worker never receives or stores it. Even with
  full server compromise, past notes cannot be decrypted.
- **AES-256-GCM with AAD:** The note ID is bound as additional authenticated
  data, preventing ID substitution attacks.
- **Server-side limits enforced:**
  - ID format: `/^[A-Za-z0-9_-]{16,64}$/` (rejects malformed IDs)
  - Max ciphertext: 200,000 chars (~150 KB)
  - TTL clamped: 60s minimum, 30 days maximum
- **Burn-after-read race condition:** There is a tiny KV race window where two
  simultaneous readers could both fetch a note before deletion. This is
  documented and acceptable for v1.
- **No CORS restriction:** `Access-Control-Allow-Origin: *` — acceptable since
  the key is never in any request.
- **No input injection:** IDs are regex-validated; ciphertext is stored as-is
  (never executed or parsed server-side beyond `JSON.parse` of the KV value).
- **External CDN deps:** Frontend loads Roboto Flex + Material Symbols Rounded
  from Google Fonts CDN.

## Tech

- Cloudflare Workers (edge serverless runtime)
- Cloudflare KV (ephemeral key-value storage with TTL)
- Frontend: vanilla HTML/CSS/JS with WebCrypto API
- Wrangler CLI for deployment
- Material Design 3, Earthy Forest (Aurex Labs Design System)
