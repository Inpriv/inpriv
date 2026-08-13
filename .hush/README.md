# hush

> Zero-knowledge end-to-end encrypted chat with WebSocket signaling.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

hush is a real-time encrypted messaging relay. Clients generate their own key
pairs in-browser and exchange public keys through the server's WebSocket
signaling channel. All message content (text, files, typing indicators) is
end-to-end encrypted client-side — the server only sees opaque ciphertext blobs
and routing metadata (client IDs). Nothing is written to disk; all state lives
in RAM and is wiped on restart.

## Features

- **E2E encrypted messaging** — keys derived and rotated in-browser; server is a blind relay
- **1:1 direct messages** with real-time key exchange via `key_request` / `key_response`
- **Group rooms** — create temporary rooms with configurable TTL (1h–1y) and message history limits
- **Global broadcast relay** — fan-out encrypted messages to all connected clients
- **File & image sharing** — up to 10 MB per frame, E2E encrypted
- **Admin panel** (`/panel`) — lockdown, text-only, proof-of-work, and EU geoblock toggles
- **EU geoblock** — blocks EU IPs in protest of Chat Control 2.0 mass-surveillance mandates
- **Zero persistence** — no database, no logs; all registries are in-memory only
- **Forward secrecy** — session keys are ephemeral and per-conversation

## Architecture

```
┌─────────────┐     wss://      ┌──────────────┐     wss://      ┌─────────────┐
│  Browser A  │ ◄────────────► │  hush relay  │ ◄────────────► │  Browser B  │
│  (keypair)  │   ciphertext    │  (server.py) │   ciphertext    │  (keypair)  │
└─────────────┘                 └──────────────┘                 └─────────────┘
                                       │
                                       │ in-memory only
                                       ├─ clients{} (id → pubkey, ws, ip)
                                       ├─ rooms{}   (id → members, history)
                                       └─ admin_sessions{} (tokens)
```

**Client-side:** Key generation, encryption/decryption (WebCrypto), all message
content rendering. The `index.html` is a self-contained single-file app with no
external dependencies — all assets are inline.

**Server-side:** The relay only routes opaque `payload` blobs between clients.
It never has access to plaintext, encryption keys, or decrypted files. It does
maintain:
- Client ID → public key mapping (needed for key exchange signaling)
- Room membership and short-lived encrypted history cache (RAM only)
- Client IP addresses (for EU geoblock enforcement; never persisted)

## Setup

### Prerequisites
- Python 3.10+
- `aiohttp` (`pip install aiohttp`)
- A reverse proxy with TLS (e.g., Cloudflare) — recommended for production

### Environment variables

Copy `.env.example` to `.env` and fill in:

```
# Admin panel credentials (REQUIRED — server won't start without these)
HUSH_ADMIN_USERNAME=your_admin_username
HUSH_ADMIN_PASSWORD=your_secure_password

# Server bind (optional — defaults shown)
HUSH_HOST=0.0.0.0
HUSH_PORT=80
```

### Run

```bash
pip install aiohttp
cp .env.example .env
# Edit .env — set HUSH_ADMIN_USERNAME and HUSH_ADMIN_PASSWORD

python server.py
```

The server starts on `HUSH_HOST:HUSH_PORT`. The web client is served at `/`,
the WebSocket endpoint at `/ws`, and the admin panel at `/panel`.

## Security

- **Zero-knowledge relay:** The server never possesses private keys or plaintext.
  It cannot decrypt any message it relays.
- **No persistence:** All state — clients, rooms, admin sessions — lives in RAM.
  A restart wipes everything.
- **Admin auth:** Cookie-based sessions with `secrets.token_hex(32)` tokens,
  `HttpOnly` + `SameSite=Strict` cookies.
- **EU geoblock:** Resolves client IPs via Cloudflare's `CF-IPCountry` header
  or the `ipapi.co` API (cached 1h). Blocks 27 EU member states.
- **Frame size limit:** 10 MB max per WebSocket frame (prevents resource abuse).
- **CSP:** The client enforces `default-src 'self'` with no external CDNs.

> **Note:** The server binds to `0.0.0.0` by default. Use a reverse proxy
> (Cloudflare, nginx, Caddy) for TLS termination in production.

## Tech

- Python 3.10+, `aiohttp` (async WebSocket server)
- Vanilla HTML/CSS/JS client (WebCrypto API for E2EE)
- No database — zero persistence by design
- Material Design 3 (Aurex Labs Design System)
