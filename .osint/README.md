# Inpriv OSINT

> AI-powered open-source intelligence search and report generator.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

OSINT aggregates search results from SearXNG (self-hosted) and DuckDuckGo
(fallback), then sends the gathered data to an LLM via OpenRouter to produce a
structured intelligence report. Queries can target people, usernames, entities,
or topics. The report includes summaries, key identifiers, digital footprint
analysis, affiliations, and notable findings — all with source citations.

## Features

- **Dual search backend:** SearXNG first (general, images, social media),
  automatic fallback to DuckDuckGo with multi-query expansion
- **AI intelligence reports:** Structured Markdown output via OpenRouter LLMs
  with configurable model selection
- **Source citations:** Every finding references bracketed source numbers `[1]`,
  `[2]` linked to the original URLs
- **Model picker:** Live list of available OpenRouter models with context length
  and pricing metadata (cached 10 min)
- **Query expansion:** Automatically generates quoted-exact and social-media-site
  variants for broader coverage
- **Panel integration:** Respects the central `.panel/config.json` suspension
  flag — returns a 503 "service suspended" page when disabled

## Architecture

```
┌────────────┐    POST /api/search    ┌──────────────┐
│  Browser   │ ────────────────────► │  OSINT API   │
│  (index    │                        │  (main.py)   │
│   .html)   │ ◄──────────────────── │              │
└────────────┘    AI report + sources └──────┬───────┘
                                              │
                           ┌──────────────────┼──────────────────┐
                           ▼                  ▼                  ▼
                    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
                    │   SearXNG   │   │ DuckDuckGo  │   │ OpenRouter  │
                    │ (or fallback)│   │  (ddgs lib) │   │   (LLM)     │
                    └─────────────┘   └─────────────┘   └─────────────┘
```

**Client-side:** Query input, model selection, and Markdown report rendering
(via `marked.js` CDN). All UI rendering is client-side.

**Server-side:** The FastAPI backend proxies search queries to SearXNG/DuckDuckGo
and LLM completions to OpenRouter. It holds no user data — queries are
stateless. The `OPENROUTER_API_KEY` lives server-side and is never exposed to
the browser.

## Setup

### Prerequisites
- Python 3.10+
- Dependencies: `fastapi`, `uvicorn`, `httpx`, `python-dotenv`, `ddgs`
- An [OpenRouter](https://openrouter.ai) API key
- (Optional) A self-hosted [SearXNG](https://searxng.org) instance

### Environment variables

Copy `.env.example` to `.env` and fill in:

```
# OpenRouter API key (REQUIRED for AI report generation)
OPENROUTER_API_KEY=your_openrouter_api_key_here

# SearXNG instance URL (optional — falls back to DuckDuckGo)
SEARXNG_URL=http://localhost:8080

# Default LLM model for reports
DEFAULT_MODEL=openai/gpt-4o-mini

# Optional overrides
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
# MODELS_CACHE_TTL=600
# HOST=0.0.0.0
# PORT=8001
```

### Run

```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env — add your OPENROUTER_API_KEY

python main.py
# → http://localhost:8001
```

## Security

- **API key isolation:** `OPENROUTER_API_KEY` is server-side only; the browser
  never sees it. Requests to OpenRouter are proxied through the backend.
- **No data persistence:** No database, no session storage, no logging of queries.
- **Panel integration:** Respects central suspension flag from `.panel/config.json`.
- **Input handling:** Search queries are passed as structured Pydantic models
  to SearXNG (URL params) and OpenRouter (JSON body) — no shell execution or
  template injection surface.
- **CORS:** Currently set to `allow_origins=["*"]` — restrict this in production
  to your known domains.
- **External CDN deps:** The frontend uses Tailwind CDN, marked.js CDN, and
  Font Awesome CDN. Consider self-hosting these for production hardening.

## Tech

- Python 3.10+, FastAPI, Uvicorn (async web server)
- `httpx` for async HTTP, `ddgs` for DuckDuckGo search
- OpenRouter for LLM inference (model-agnostic)
- Frontend: HTML + Tailwind (CDN) + marked.js (CDN)
- Material Design 3 (Inpriv Labs Design System)
