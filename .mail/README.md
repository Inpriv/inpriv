# Inpriv Mail

> Zero-knowledge encrypted email with hybrid RSA + AES-GCM encryption.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Inpriv Mail is a disposable encrypted email service. Users register an
`@inpriv.xyz` address and generate RSA-OAEP-2048 key pairs in the browser.
The private key is wrapped with AES-GCM using a key derived from the user's
password (PBKDF2) — the server stores only the encrypted private key blob and
can never decrypt messages. Internal mail uses hybrid encryption (RSA-wrapped
AES key + AES-GCM ciphertext). Inbound external mail arrives via a Cloudflare
Email Worker catch-all and is encrypted server-side to the recipient's public
key (the server still can't decrypt it afterward since it lacks the private key).

## Features

- **Zero-knowledge encryption:** Private keys never leave the browser unencrypted;
  the server stores only AES-GCM-wrapped PKCS#8 blobs
- **Hybrid encryption:** Internal messages use RSA-OAEP-2048 to wrap a random
  AES-256 key + AES-GCM-256 for the body
- **External inbound mail:** Cloudflare Email Worker catch-all (`*@inpriv.xyz`)
  forwards raw RFC822 to the backend, which encrypts to the recipient's public key
- **Argon2id password hashing:** Server-side auth uses Argon2 with
  constant-time verification
- **JWT sessions:** 30-day tokens with `jti` (token IDs) for revocation support
- **Username validation:** Strict regex (`^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$`)
  with length bounds
- **Message management:** List, read, delete, send — all with owner-scoped access
- **Read receipts:** Inbound messages track `is_read` state
- **Username enumeration protection:** Inbound webhook silently accepts unknown
  recipients to prevent user enumeration

## Architecture

```
┌──────────────┐                   ┌──────────────┐                ┌──────────────┐
│  Browser     │   REST API (JWT)  │  Mail API    │   SQLite       │  inpriv.db   │
│  (index.html)│ ◄───────────────► │  (main.py)   │ ◄────────────► │              │
│              │                   │  FastAPI     │                └──────────────┘
│  Generates   │                   └──────┬───────┘
│  RSA keypair │                          │ POST /api/v1/inbound-email
│  in-browser  │                          │ (X-Webhook-Secret)
└──────────────┘                          │
                                          ▼
                              ┌──────────────────────┐
                              │ Cloudflare Email     │
                              │ Worker (catch-all)   │
                              │ *@inpriv.xyz         │
                              └──────────────────────┘
```

**Client-side:** RSA-OAEP-2048 key generation, PBKDF2 key derivation from
password, private key wrapping/unwrapping, hybrid message encryption/decryption.
The browser derives the AES key from the user's password and decrypts the
private key locally.

**Server-side:** Stores Argon2id password hashes, public keys, and AES-GCM-
encrypted private key bundles. For internal mail, it stores only ciphertext
(triple of `encrypted_aes_key`, `iv`, `ciphertext`, `auth_tag`). For inbound
external mail, it performs hybrid encryption to the recipient's public key —
but since it never has the private key, it cannot decrypt anything it stores.

## Setup

### Prerequisites
- Python 3.10+
- Dependencies: `fastapi`, `uvicorn[standard]`, `sqlmodel`, `python-jose[cryptography]`,
  `argon2-cffi`, `pydantic-settings`, `cryptography`
- Cloudflare account with Email Routing enabled
- `cloudflared` CLI (for tunnel setup)

### Environment variables

Copy `.env.example` to `.env` and fill in:

```
# JWT signing secret — generate with: openssl rand -hex 32
JWT_SECRET=<64+ char random string>

# Shared secret for Cloudflare Email Worker webhook (must match Worker env)
INBOUND_EMAIL_SECRET=<64+ char random string>

# CORS origins (comma-separated)
CORS_ORIGINS=https://mail.inpriv.xyz

# SQLite database path
DB_PATH=inpriv.db
```

### Run

**Automated setup (recommended for first-time deployment):**

```bash
chmod +x setup.sh start.sh
./setup.sh    # Generates secrets, creates .env, sets up Cloudflare tunnel
./start.sh    # Starts FastAPI backend + Cloudflare tunnel
```

**Manual run:**

```bash
pip install fastapi "uvicorn[standard]" sqlmodel "python-jose[cryptography]" \
    argon2-cffi pydantic-settings cryptography
cp .env.example .env
# Edit .env — set JWT_SECRET and INBOUND_EMAIL_SECRET

uvicorn main:app --host 127.0.0.1 --port 8000 --proxy-headers
```

### Cloudflare Email Worker

The `main.py` file header contains a ready-to-paste Cloudflare Email Worker
script. Deploy it as a catch-all route for `*@inpriv.xyz` with the
`INBOUND_EMAIL_SECRET` environment variable matching your `.env`. See the
in-file documentation for full DNS and routing setup instructions.

## Security

- **Zero-knowledge by design:** The server never possesses a user's private key.
  Private keys are AES-GCM encrypted in the browser before upload, using a key
  derived from the user's password via PBKDF2 (100k+ iterations).
- **Argon2id passwords:** Server-side authentication hashes use Argon2id with
  constant-time verification and automatic rehashing when parameters upgrade.
- **JWT with unique IDs:** Each token carries a `jti` claim for revocation
  tracking. 30-day TTL by default.
- **Inbound webhook auth:** The Cloudflare Email Worker authenticates via
  `X-Webhook-Secret` header with constant-time comparison
  (`secrets.compare_digest`).
- **Anti-enumeration:** Unknown recipients in the inbound webhook return
  `{"ok": true}` to prevent username discovery.
- **Owner-scoped access:** Every message query is filtered by `owner_id == user.id`.
  Cross-user access returns 404.
- **SQL injection safe:** Uses SQLModel/SQLAlchemy ORM with parameterized queries.
- **Input validation:** Pydantic models enforce username regex, password min
  length (10+), and field length bounds.

## Tech

- Python 3.10+, FastAPI, Uvicorn
- SQLModel + SQLite (ORM with parameterized queries)
- `python-jose` (JWT), `argon2-cffi` (password hashing)
- `cryptography` (RSA-OAEP-2048 + AES-GCM-256 hybrid encryption)
- Cloudflare Email Workers (inbound catch-all routing)
- Cloudflare Tunnel (`cloudflared`) for TLS termination
- Frontend: Roboto Flex + Material Symbols Rounded (Google Fonts)
- Material Design 3 (Aurex Labs Design System)
