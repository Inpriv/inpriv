# Inpriv Trace

**One scan, three privacy checks** — your public IP & ISP, a DNS leak test, and a WebRTC leak test, unified in a single mobile-first page.

Live at **https://trace.inpriv.xyz**

## What it does

`Inpriv Trace` merges three previously separate tools into one scan:

| Check | Method |
|---|---|
| **IP & Network** | Public IP / ISP / ASN / geo lookup via `ipwho.is` (fallback `ipapi.co`), tagged Residential vs VPN/Datacenter |
| **DNS Leak** | DoH probes against Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) with egress geolocation, plus an OS-resolver connectivity probe; compares resolver egress against the HTTP exit (tunnel-leak + geo-mismatch heuristics) |
| **WebRTC Leak** | ICE candidate gathering over 4 STUN servers (Google, Cloudflare, Mozilla, Nextcloud), local/mDNS interface detection, media-device enumeration, residential-vs-VPN correlation against the HTTP baseline |

A **privacy score (0–100)** and an overall verdict summarize all three, and the toolbar button copies a full JSON audit report.

## Privacy

- Zero-knowledge: no accounts, no storage, no telemetry. The page is static.
- Lookups go **directly from the visitor's browser** to public APIs (`ipwho.is`, `ipapi.co`, Cloudflare/Google DoH). The Inpriv worker never sees or logs results.
- CSP-restricted (`connect-src` limited to the four lookup endpoints).

## Tech

Single self-contained `index.html` (Inpriv Labs M3 Earthy Forest design system, Roboto Flex + Material Symbols Rounded, dark theme default, glass app bar, spring motion). Deployed as a Cloudflare Worker with static assets + the shared maintenance gate (`common/gate.js`, kill-switch wired to admin.inpriv.xyz, `run_worker_first = true`).

## Deploy

```bash
cd worker
cp ../index.html public/index.html
npx wrangler deploy
```

## History

Replaces `ipinfo.inpriv.xyz`, `dns.inpriv.xyz` and `webrtc.inpriv.xyz` (2026-08). Those subdomains now redirect here. The legacy tools live in git history under `.ipinfo/`, `.dns/`, `.webrtc/`.

— Inpriv Labs, MIT License
