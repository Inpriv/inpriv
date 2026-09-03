# Inpriv Amber

**Personal web archive** — a private Wayback-Machine-style tool for the Inpriv
suite. Paste a link, Amber captures the page (plus same-host subpages and
assets), stores it as a ZIP on your own Google Drive, and puts it on a
browsable timeline. Read archived pages offline in the built-in sandboxed
viewer, search your archive, download any snapshot as a plain ZIP.

Part of the [Inpriv](https://inpriv.xyz) suite by Inpriv Labs — MIT licensed.

## How it works

```
URL ──▶ capture worker (SSRF-guarded fetch)
          ├─ main page + up to 3 same-host subpages
          ├─ up to 40 assets (CSS rewritten, images, fonts…)
          ├─ scripts stripped at capture time
          └─ links rewritten to /a/<snapshot>/… archive namespace
       ──▶ ZIP (store method) ──▶ Google Drive  (folder "inpriv/.amber")
       ──▶ metadata + page map in Cloudflare D1
       ──▶ search index (tokens) next to the ZIP on Drive
```

- **Viewer** serves pages straight out of the ZIP with a `CSP: sandbox`
  header (opaque origin) — archived code can never touch your session.
- **Storage** is your own Google Drive via user OAuth (same pattern as Host
  and Burn). D1 keeps only metadata (≤ a few KB per snapshot).
- **Auth** is a regular Inpriv ID account: password + TOTP or Quick Sign-In
  (SSO). Sessions work as Bearer tokens for the SPA *and* as an HttpOnly
  cookie for iframe navigations.
- **Search** combines SQL (host/URL/title) with per-snapshot token indexes
  stored on Drive — full-page-text search without a search server.

## Limits (defaults)

| Limit | Value |
|---|---|
| Snapshot size (ZIP) | 40 MB |
| Per-page / per-asset | 5 MB / 8 MB |
| Pages per snapshot | 1 + 3 same-host subpages |
| Assets per snapshot | 40 |
| Captures | 30 / hour / account |
| Storage quota | 512 MB / account (`QUOTA_BYTES` var) |

## Stack

- Cloudflare Worker (module) + Workers Assets, custom domain
  `amber.inpriv.xyz`
- Cloudflare D1 (metadata), Google Drive (blobs + search indexes)
- Single-file frontend (`index.html`), M3 Earthy Forest design system,
  no frameworks, no telemetry, English UI

## Development

```bash
cd worker
npx wrangler deploy          # deploy (custom domain auto-configured)

# secrets
npx wrangler secret put DRIVE_OAUTH   # {"client_id","client_secret","refresh_token"}
npx wrangler secret put SERVICE_KEY   # shared Inpriv ID service key

# database
npx wrangler d1 execute inpriv-amber --remote --file=schema.sql
```

`DRIVE_PARENT` is the Drive folder id that holds the per-service folder
(`DRIVE_FOLDER_NAME = ".amber"`); it is created lazily on first upload.

## Privacy

- No raw IPs or user agents are ever stored (rate limiting uses /24 buckets).
- Captured pages run in an opaque sandboxed origin; scripts are stripped.
- Snapshots belong to exactly one account — every read re-checks ownership.
- The archive viewer never caches auth-negative lookups.

## License

MIT — see the root [LICENSE](../LICENSE).
