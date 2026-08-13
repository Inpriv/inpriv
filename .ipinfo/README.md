# Inpriv IP Info

> See exactly what your browser reveals — public IP, ISP, geolocation, and a full client-side device fingerprint.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

IP Info is a browser exposure diagnostic tool. It performs two functions: (1) a **public IP lookup** that shows your IP address, ISP, ASN, and approximate geolocation via external API calls, and (2) a **fully client-side device fingerprint** that enumerates your browser, OS, screen, hardware, WebGL renderer, timezone, and more — all read locally from the `navigator` API. Nothing about your fingerprint is uploaded.

## Features

- **Public IP hero card** with ISP, organization, ASN, domain, and residential-vs-VPN/datacenter detection
- **Network & ISP card**: IP, ISP, organization, ASN, domain, connection type
- **Geolocation card**: city, region, country (with flag emoji), postal code, coordinates (with OpenStreetMap link), EU membership, calling code
- **Browser & OS card**: parsed browser name+version, OS, platform, languages, cookie status, online status
- **Display & Device card**: screen resolution, viewport, color depth, pixel ratio, touch capability
- **Fingerprint surface card**: timezone, CPU cores, device memory, Do Not Track, color scheme, WebGL vendor & renderer (via `WEBGL_debug_renderer_info`)
- **Locally observable headers card**: User-Agent and Accept-Language (read from `navigator`, not a server round-trip)
- **VPN/datacenter heuristic** using a keyword list (mullvad, nordvpn, digitalocean, AWS, cloudflare, etc.)
- **Refresh** button to re-scan; **Export JSON** report to clipboard
- **Copy-to-clipboard** on any field value
- **Light/dark theme** (defaults to dark), persisted in localStorage

## How it works

1. **IP intel** (`getIpIntel()`): Fetches `https://ipwho.is/` first; on failure falls back to `https://ipapi.co/json/`. The response is normalized into a common shape. ISP/org/ASN strings are checked against a VPN/datacenter keyword list to classify the connection.
2. **Local fingerprint** (`localData()`): Reads `navigator.userAgent`, `navigator.languages`, `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `navigator.doNotTrack`, `navigator.platform`, `screen.*`, `window.devicePixelRatio`, `Intl.DateTimeFormat` timezone, and `matchMedia` color scheme — all client-side.
3. **WebGL info** (`webglInfo()`): Creates an offscreen canvas, gets a WebGL context, and uses the `WEBGL_debug_renderer_info` extension to read the unmasked GPU vendor and renderer strings.
4. **UA parsing** (`parseUA()`): Regex-based browser and OS detection from the User-Agent string.
5. **Rendering**: An `esc()` function HTML-escapes all values before inserting via `innerHTML`. Copy buttons use `data-copy` attributes read at click time.
6. **Export**: Builds a JSON report object combining IP intel + client data, copies it to the clipboard.

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.ipinfo/index.html
```

## Security

- ✅ Fingerprint data is 100% client-side — read from `navigator` and `screen`, never uploaded
- ✅ All dynamic output HTML-escaped via `esc()` before `innerHTML` insertion
- ⚠️ **Makes external network requests**: `ipwho.is` and `ipapi.co` (fallback) to resolve your public IP — this is by design (you cannot learn your public IP without asking a server), but be aware these services see your real IP
- ℹ️ VPN/datacenter classification is a keyword heuristic, not definitive
- ℹ️ External dependencies: Google Fonts (Roboto Flex, Material Symbols Rounded) and favicon from `hush.best`
- ℹ️ `localStorage` used only for theme preference

## Tech

- Vanilla HTML/CSS/JS (single `index.html`, no build step)
- `fetch` API for IP lookups, `navigator`/`screen` APIs for fingerprint
- WebGL `WEBGL_debug_renderer_info` extension
- Material Design 3 (Aurex Labs Design System — Earthy Forest)
