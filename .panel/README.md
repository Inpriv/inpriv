# Inpriv Panel

> Centralized operations dashboard for the Inpriv privacy suite.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

The Panel is the administrative control center for all Inpriv micro-services.
It manages service enable/disable states, global configuration (EU geoblock
policy, custom block messaging), and GeoIP validation. Each micro-service reads
`config.json` at runtime to check whether it should serve traffic or display a
suspension notice — making the Panel the single source of truth for the entire
suite's operational state.

## Features

- **Service management:** Enable/disable any Inpriv service (mail, totp, pay,
  zero, hush, osint) with instant effect
- **Per-service config:** Edit domains, ports, and custom options for each service
- **Global EU geoblock:** Toggle IP-based blocking of EU/EEA regions (27 EU +
  IS, LI, NO, CH) in protest of Chat Control 2.0 surveillance mandates
- **Custom block messaging:** Configurable title, message, and privacy-stance
  display for blocked visitors
- **GeoIP lookup:** Real-time IP → country resolution via ip-api.com (primary)
  and ipapi.co (fallback), cached 1 hour
- **IP validation API:** `POST /api/validate-ip` endpoint used by other services
  to check visitor IPs against the EU block
- **Config reset:** One-click factory reset to default configuration
- **Atomic config writes:** All writes use temp-file + rename for crash safety

## Architecture

```
┌──────────────┐     HTTP      ┌──────────────┐     read/write     ┌──────────────┐
│  Admin       │ ◄──────────► │  Panel API   │ ◄────────────────► │  config.json │
│  Browser     │   REST API   │  (main.py)   │                    │  (on disk)   │
└──────────────┘              └──────┬───────┘                    └──────────────┘
                                     │
                                     │ GeoIP lookups
                                     ▼
                              ┌─────────────┐
                              │ ip-api.com  │
                              │ ipapi.co    │
                              └─────────────┘
```

**Client-side:** The `index.html` dashboard fetches and updates service state
via the REST API. Google Fonts (Inter, JetBrains Mono) loaded from CDN.

**Server-side:** FastAPI reads/writes `config.json` atomically. Other
micro-services (`.osint`, `.hush`, etc.) read this same `config.json` to check
their enabled state and EU block policy. GeoIP lookups are cached in-memory.

> **Note:** This service is **not** part of the public zero-knowledge surface.
> It is an internal administration tool and should be access-controlled at the
> network level (firewall, VPN, or Cloudflare Access).

## Setup

### Prerequisites
- Python 3.10+
- Dependencies: `fastapi`, `uvicorn`, `python-dotenv`, `httpx`

### Environment variables

Copy `.env.example` to `.env` and fill in:

```
# Server bind address
HOST=0.0.0.0
PORT=9000
```

### Run

```bash
pip install -r requirements.txt
cp .env.example .env

python main.py
# → http://localhost:9000
```

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/services` | List all services and their config |
| `GET` | `/api/services/{name}` | Get a single service's config |
| `PUT` | `/api/services/{name}` | Update a service's config |
| `GET` | `/api/global` | Get global settings (EU block, messages) |
| `PUT` | `/api/global` | Update global settings |
| `GET` | `/api/geoip/check?ip=1.2.3.4` | Check if an IP is EU-blocked |
| `POST` | `/api/validate-ip` | Validate client IP against EU block |
| `POST` | `/api/reset` | Reset config to factory defaults |

## Security

- **No built-in auth:** The Panel API has no authentication layer. It relies
  entirely on network-level access control. **This is a known design decision**
  — the panel must be firewalled, VPN-gated, or placed behind Cloudflare Access.
- **Atomic writes:** Config changes write to a `.json.tmp` file then atomically
  rename, preventing corruption on crash.
- **GeoIP privacy:** IP lookups are proxied through third-party APIs
  (ip-api.com, ipapi.co). No IP database is stored locally; cache is in-memory
  only with a 1-hour TTL.
- **CORS:** Currently set to `allow_origins=["*"]` — restrict this in production.
- **No SQL injection surface:** Uses JSON file storage, not a SQL database.
- **Input validation:** Pydantic models validate all PUT/POST bodies.

## Tech

- Python 3.10+, FastAPI, Uvicorn
- `httpx` for async GeoIP lookups
- JSON file storage (`config.json`) with atomic writes
- Frontend: HTML + Google Fonts (Inter, JetBrains Mono)
- Material Design 3 (Aurex Labs Design System)
