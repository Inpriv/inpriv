# Inpriv TOTP

> RFC 6238 time-based one-time password (2FA) authenticator — fully client-side, zero-knowledge.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

TOTP is a two-factor authentication app that generates time-based one-time codes (RFC 6238 / HOTP) entirely in your browser. Add accounts by pasting an `otpauth://` URI (exported from Google Authenticator, Aegis, etc.) or a raw Base32 secret, or generate a fresh secret. Seeds can optionally be encrypted with a passphrase (AES-256-GCM) and stored locally. Codes refresh every 30 seconds with a live countdown ring.

## Features

- **RFC 6238 TOTP** generation via HMAC-SHA1 (Web Crypto API)
- **Add accounts** from `otpauth://` URIs or raw Base32 secrets
- **Generate fresh secrets** — 20 random bytes, Base32-encoded
- **Optional encrypted vault**: passphrase-protect your seeds with AES-256-GCM (PBKDF2 key derivation, 100k iterations)
- **Lock/unlock** screen when a passphrase is set
- **Live countdown ring** (SVG) showing seconds remaining in the current period
- **Click to copy** code to clipboard
- **QR code share/migrate** — generates a scannable `otpauth://` QR (via `qrcode-generator` library) for exporting to another authenticator app
- **Delete** accounts with confirmation
- **Light/dark theme** (defaults to dark), persisted in localStorage
- **PWA-ready** meta tags (apple-mobile-web-app-capable, theme-color, standalone title)
- **Ripple** touch feedback on all interactive elements

## How it works

1. **Base32** (`b32encode`/`b32decode`): Pure-JS Base32 codec for encoding generated secrets and decoding user-supplied secrets per RFC 4648.
2. **TOTP** (`totpCode()`): Computes the time counter `floor(unix_time / period)`, packs it into an 8-byte big-endian message, imports the Base32-decoded secret as an HMAC-SHA1 key via `crypto.subtle`, signs the message, and applies dynamic truncation (RFC 4226) to extract the code.
3. **Vault storage**: Two modes —
   - **Unencrypted**: accounts stored as plaintext JSON in `localStorage` (`inpriv_totp_vault_v1`)
   - **Encrypted**: passphrase derives a 256-bit AES-GCM key via PBKDF2-SHA256 (100k iterations, 16-byte salt, 12-byte IV); accounts are encrypted before storage
4. **otpauth parsing** (`parseOtpauth()`): Regex-extracts the label, secret, period, digits, and issuer from `otpauth://totp/...` URIs.
5. **QR generation**: Uses the `qrcode-generator` CDN library (version 1.4.4) to render an SVG QR code of the `otpauth://` URI.
6. **Refresh loop**: `setInterval(refreshCodes, 250)` updates codes and countdown rings 4×/s.

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.totp/index.html
```

> A local server (not `file://`) is required so the Web Crypto API and clipboard API are available.

## Security

- ✅ Client-side only — code generation uses Web Crypto (`crypto.subtle`), no server involved
- ✅ Seeds never leave the browser; optional AES-256-GCM encryption at rest
- ✅ All dynamic output uses `escapeHTML()` before `innerHTML` insertion
- ⚠️ **External CDN dependency**: `qrcode-generator` v1.4.4 from `cdnjs.cloudflare.com` — loaded for QR code rendering only; if you require a fully self-contained build, vendor this library locally
- ⚠️ Unencrypted mode stores secrets in plaintext in `localStorage` — set a passphrase to encrypt them
- ℹ️ PBKDF2 iteration count is 100,000 (lower than Keyring's 600k; adequate but could be raised)
- ℹ️ External dependencies: Google Fonts (Roboto Flex, Material Symbols Rounded), favicon and logo from `hush.best`, qrcode-generator from cdnjs

## Tech

- Vanilla HTML/CSS/JS (single `index.html`, no build step)
- Web Crypto API (`crypto.subtle`) for HMAC-SHA1 and AES-GCM
- Base32 codec (pure JS)
- `qrcode-generator` library (CDN) for QR rendering
- Material Design 3 (Inpriv Labs Design System — Earthy Forest)
