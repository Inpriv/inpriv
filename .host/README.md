# Inpriv Host

**Private static hosting with a built-in privacy shield.** Host your own pages,
images and files on `host.inpriv.xyz` — every upload is scanned for IP loggers,
WebRTC leak probes, pixel beacons and tracker scripts **before** it is published.
Files that fail the scan are quarantined and never served.

- URL: <https://host.inpriv.xyz>
- Login: Inpriv ID (`id.inpriv.xyz`) — username + master password (+ TOTP when enabled)
- Storage: your Google Drive (service account, 50 GB quota per account)
- Limits: 100 MB per file · 5000 files per account

## How it works

```
Browser ──chunked upload──▶ Worker ──scan──▶ blocked? → quarantined (never served)
                              │
                              └──clean──▶ Google Drive (UUID filename)
                                             │
Visitor ──GET /f/<slug>◀── Worker ◀──stream──┘   (sandbox + stealth headers)
```

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
- **Storage**: files live in a Google Drive owned by a service account; the
  Drive filename is the file UUID — original names never leave D1.
- **Serving**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` locked down, `Timing-Allow-Origin: none`, sandbox CSP on
  every served file, 6 h edge cache.
- **Kill-switch**: wired to `admin.inpriv.xyz` (service id `host`).

## Google Cloud setup (one-time, ~5 minutes)

1. Go to <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → Library** → search **"Google Drive API"** → **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**
   (name it e.g. `inpriv-host-storage`; no roles needed).
4. Open the account → **Keys → Add key → Create new key → JSON** → download.
5. Copy the whole JSON file content and set it as a Worker secret:
   `npx wrangler secret put DRIVE_SERVICE_ACCOUNT --name inpriv-host`
6. (Optional) In Google Drive, create a folder, share it with the service
   account's email (Editor), copy the folder id from the URL and set it as
   `DRIVE_FOLDER_ID` in `worker/wrangler.toml`.

## Deploy

```bash
cd .host/worker
npx wrangler d1 create inpriv-host          # paste id into wrangler.toml
npx wrangler kv namespace create HOST_KV    # paste id into wrangler.toml
npx wrangler d1 execute inpriv-host --remote --file=schema.sql
cp ../index.html public/index.html
npx wrangler secret put DRIVE_SERVICE_ACCOUNT
npx wrangler deploy
```

## Structure

```
.host/
├── index.html          # single-file dashboard (source of truth)
├── README.md
└── worker/
    ├── wrangler.toml
    ├── schema.sql
    ├── src/index.js    # API + scanner + Drive proxy
    └── public/index.html  # copy of the dashboard
```
