# Inpriv DNS — DNS Leak Test

> Client-side DNS leak detection. Resolve test hostnames through multiple DNS-over-HTTPS resolvers and compare against your HTTP egress IP. Honest, in-browser, zero-knowledge.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

DNS Leak Test resolves test hostnames through multiple DNS-over-HTTPS (DoH) resolvers directly from your browser, then compares their egress IP against your HTTP gateway IP to detect routing mismatches. It is transparent about its limitations: a pure web page cannot observe the OS resolver's recursive queries, so this is an honest approximation — not an authoritative resolver-log test like dnsleaktest.com.

## Features

- **DoH resolver probing** — queries Cloudflare and Google DoH endpoints (CORS-enabled)
- **HTTP gateway baseline** — fetches your HTTP egress IP with ISP/ASN/geolocation
- **OS resolver observation** — attempts to resolve a fresh random hostname (connectivity check)
- **Resolution posture matrix** — HTTP↔DNS egress alignment, resolver diversity, tunnel consistency
- **VPN/datacenter detection** — keyword engine flags known VPN/hosting providers
- **Honest limitations panel** — expandable section explaining what the test can and cannot do
- **JSON report export** — full audit results copied to clipboard
- **Dark/light theme** toggle with system preference detection

## How it works

The tool queries Cloudflare (`cloudflare-dns.com`) and Google (`dns.google`) DoH JSON endpoints (`application/dns-json`) with random uncached hostnames. It geolocates each resolver's well-known anycast IP (`1.1.1.1`, `8.8.8.8`) via `ipwho.is` (fallback: `ipapi.co`) to determine egress country/ISP. It separately fetches your HTTP egress IP. The audit then compares: (1) whether DNS egress countries align with HTTP egress country, (2) resolver diversity, and (3) whether DNS traffic escapes a VPN tunnel (HTTP is VPN but DNS resolver egress is residential). An OS resolver observation sends a `no-cors` fetch to a random hostname to confirm resolution works (browsers don't expose the resolved IP).

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.dns/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no backend involved
- ✅ No `eval()`, no hardcoded secrets
- ✅ Transparent about test limitations (documented in-app)
- ⚠️ Makes external calls to `ipwho.is`, `ipapi.co` (IP geolocation), and DoH endpoints (Cloudflare, Google) — your IP is sent to these services by design
- ⚠️ `innerHTML` used with API-returned data (ISP/location) and constructed resolver rows — not directly user-controlled but worth sanitizing
- ⚠️ External favicon referenced from `hush.best`
- ⚠️ External font dependencies (Google Fonts)
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Inpriv Labs Design System)
- DNS-over-HTTPS (DoH) JSON API (`application/dns-json`)
- Fetch API for IP intelligence and DoH queries
- Roboto Flex + Material Symbols Rounded (Google Fonts)
