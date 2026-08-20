# Inpriv Host

**Private static hosting with a built-in privacy shield — open to everyone.** Host your
own pages, images and files on `host.inpriv.xyz` — every upload is scanned for IP
loggers, WebRTC leak probes, pixel beacons and tracker scripts **before** it is
published. Files that fail the scan are quarantined and never served.

- URL: <https://host.inpriv.xyz>
- **Guest mode**: no account needed — 50 MB per file, random links, auto-deleted after 7 days
- **Inpriv ID** (`id.inpriv.xyz`): 100 MB per file, permanent links, custom URLs
  (`host.inpriv.xyz/s/your-name`), file manager — and a "request higher limit" flow
  (encrypted end-to-end, delivered to the operator's Inpriv Mail inbox)
- Storage: Google Drive (user OAuth) · 50 GB per account · 2 GB/week rolling for guests
- License: MIT — deploy your own instance (see *Deploy* below)

## How it works

```
Guest / Inpriv ID user ──chunked upload──▶ Worker ──scan──▶ blocked? → quarantined (never served)
                                             │
                                             └──clean──▶ Google Drive (UUID filename)
                                                            │
Visitor ──GET /f/<slug> or /s/<custom>◀── Worker ◀──stream──┘   (sandbox + stealth headers)
```

## Tiers

| | Guest (no account) | Signed-in (Inpriv ID) |
|---|---|---|
| Per-file limit | 50 MB | 100 MB (raisable on request) |
| Storage | 2 GB / network / week | 50 GB per account |
| Link style | random `host.inpriv.xyz/f/xxxx` | random + custom `host.inpriv.xyz/s/your-name` |
| Lifetime | 7 days, auto-delete | permanent |
| Management | manage key (shown once after upload) | full file manager |
| Privacy shield | yes — identical scanner | yes — identical scanner |

## Privacy shield

| Threat                        | Protection                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------- |
| IP loggers / grabbers         | 60+ known grabber domains hard-blocked at upload (iplogger, grabify, yip.su, ...) |
| WebRTC IP leak                | any `RTCPeerConnection` / ICE / STUN usage blocks the file                        |
| Pixel & image beacons         | remote `<img>`, `new Image().src=…` blocked                                      |
| Trackers & external scripts   | only known CDNs allowed (jsdelivr, cdnjs, unpkg, jQuery, Google Fonts, esm.sh)    |
| Covert redirects              | meta-refresh / JS redirect / `<noscript>` redirect to external URLs blocked       |
| CSS exfiltration              | `@import` / `url()` to remote origins blocked                                    |
| Obfuscation                   | `eval`, `new Function`, `document.write(atob(…))` blocked                        |
| Visitor fingerprinting        | sandbox CSP (`default-src 'none'`), `no-referrer`, no plugins/USB/payment         |
| Owner privacy                 | no IPs / user agents stored — rate limiting uses hashed prefixes in short buckets |

Active content (HTML/CSS/JS/SVG/XML/PDF) is **always served as a download** with
`Content-Disposition: attachment` — it never executes in the context of the site,
so a served page cannot phone home even if something slipped through the scan.
Images and media play inline.

## Security model

- **Auth**: verified against the Inpriv ID database (PBKDF2 300k iterations,
  3 × 100k chained rounds) + TOTP when enabled. Host issues its own opaque
  session tokens (SHA-256 at rest). The dashboard itself runs under a strict CSP.
- **Guest uploads**: keyed to a hashed IP-prefix bucket (never a raw IP), limited
  to 30 uploads / network / day and 2 GB / network / week, expiring after 7 days.
  Guests get a one-time **manage key** to delete their file early.
- **Storage**: files live on the operator's Google Drive via OAuth; the Drive
  filename is the file UUID — original names never leave D1.
- **Serving**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` locked down, `Timing-Allow-Origin: none`, sandbox CSP on
  every served file, 6 h edge cache.
- **Limit requests**: the reason text is encrypted in the browser (RSA-OAEP +
  AES-GCM) to the operator's Inpriv Mail public key — the server only stores the
  ciphertext and routes metadata.
- **Kill-switch**: wired to `admin.inpriv.xyz` (service id `host`).

## Google Cloud setup (one-time, ~5 minutes)

Works with either a **service account** (Workspace shared drives) or **user OAuth**
(consumer Drive — recommended):

1. Go to <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → Library** → search **"Google Drive API"** → **Enable**.
3. For user OAuth (files on your own Drive):
   - **OAuth consent screen** → External → publish the app.
   - **Credentials → Create credentials → OAuth client ID → Desktop app** → download JSON.
   - Run a one-time consent flow (offline access) to obtain a refresh token.
   - `npx wrangler secret put DRIVE_OAUTH` with
     `{"client_id":"…","client_secret":"…","refresh_token":"…"}`.
   - Optional: set `DRIVE_FOLDER_ID` in `worker/wrangler.toml` to a folder on your Drive.
4. For a service account: **IAM & Admin → Service Accounts → Create**, JSON key →
   `npx wrangler secret put DRIVE_SERVICE_ACCOUNT`. (Note: SAs have no storage
   quota on consumer accounts — use a shared drive.)

## Deploy

```bash
cd .host/worker
npx wrangler d1 create inpriv-host          # paste id into wrangler.toml
npx wrangler kv namespace create HOST_KV    # paste id into wrangler.toml
npx wrangler d1 execute inpriv-host --remote --file=schema.sql
cp ../index.html public/index.html
npx wrangler secret put DRIVE_OAUTH         # or DRIVE_SERVICE_ACCOUNT
npx wrangler deploy
```

Self-hosting note: the worker also binds `ID_DB` (Inpriv ID) for sign-in and
`MAIL_DB` (Inpriv Mail) to deliver encrypted limit requests to the operator.
Point them at your own instances to run a fully independent copy.

## Structure

```
.host/
├── index.html          # single-file dashboard (source of truth)
├── README.md
└── worker/
    ├── wrangler.toml
    ├── schema.sql
    ├── src/index.js    # API + scanner + Drive proxy + guest mode + cron
    └── public/index.html  # copy of the dashboard
```
