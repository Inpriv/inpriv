# Inpriv Status

**[status.inpriv.xyz](https://status.inpriv.xyz)** — live health, response time
and 7-day uptime for every Inpriv Labs tool, on one page.

## What it does

- **Edge probing** — the Worker fetches every service homepage from
  Cloudflare's edge (20 services in parallel, 8 s timeout each) and reports
  `up`/`down` plus response time.
- **Live page** — Material Design 3 (earthy forest) frontend, dark/light
  theme, auto-refresh every 30 s, per-service 7-day uptime bars.
- **Kill-switch aware** — services paused via
  [admin.inpriv.xyz](https://admin.inpriv.xyz) show as **Paused** (orange),
  not Down. The status page itself is also gated (`status` service id).
- **Privacy** — no IPs, no user data, no logs. Only aggregated per-service
  poll results are stored, in 7 daily KV buckets (auto-expire after 8 days).

## API (public, read-only)

| Endpoint | Description |
|---|---|
| `GET /api/status` | Live snapshot: `{ checkedAt, today, services: { <id>: { s, ms, code, t } } }` |
| `GET /api/history` | 7-day daily buckets per service: `{ days, today, services: { <id>: [ { d, s, ms } ] } }` |
| `GET /api/health` | Always `{ ok: true }` — for external monitoring |

`<id>` values match the admin kill-switch ids (`landing`, `account`, `mail`, …).

## Stack

- Cloudflare Worker + static assets (single-file `public/index.html`)
- KV namespace `STATUS_KV` (snapshot cache 1 h, daily buckets TTL 8 days)
- Shared maintenance gate (`common/gate.js`), fail-open

## Local development

```bash
cd worker
npx wrangler dev
```

## Deploy

```bash
cd worker
npx wrangler deploy
```

---
Copyright (c) 2026 Inpriv Labs — MIT License
