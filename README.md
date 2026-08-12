<div align="center">

<img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ABD37A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/%3E%3Cpath d='M9 12l2 2 4-4'/%3E%3C/svg%3E" width="48" height="48" alt="Inpriv shield">

# Inpriv

### Zero-knowledge. Client-side only.

**A suite of privacy-first web utilities engineered for total digital privacy.**

No trackers. No remote logs. No compromises — everything runs in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-inpriv.xyz-466E47)](https://inpriv.xyz)
[![Tools](https://img.shields.io/badge/tools-11%20live%20%2B%209%20coming%20soon-ABD37A)](https://inpriv.xyz)
[![Zero-Knowledge](https://img.shields.io/badge/zero--knowledge-%E2%9C%93-C7EFA0)]()
[![By Aurex Labs](https://img.shields.io/badge/by-Aurex%20Labs-9C4231)]()

<img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E" width="14" height="14" alt=""> Quick links: [Website](https://inpriv.xyz) · [License](LICENSE)

</div>

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpolygon points='16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Overview

Inpriv is an ecosystem of **zero-knowledge, fully client-side web utilities** — engineered so your sensitive data **never leaves your device**. No accounts, no servers, no telemetry, no log files. What happens in your browser, stays in your browser.

> **Why "zero-knowledge"?** Because the system — by design — holds *zero* knowledge about you. There is nothing to leak, nothing to subpoena, nothing to sell.

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2330a46e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 11.08V12a10 10 0 1 1-5.93-9.14'/%3E%3Cpolyline points='22 4 12 14.01 9 11.01'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Live Tools

- **Hush** — [hush.best](https://hush.best) — E2E encrypted chat. Forward-secret rooms, QR sharing, zero metadata
- **Wipe** — [wipe.inpriv.xyz](https://wipe.inpriv.xyz) — metadata (EXIF/GPS) sanitizer for images
- **Compress** — [compress.inpriv.xyz](https://compress.inpriv.xyz) — image compression, no uploads
- **WebRTC Leak** — [webrtc.inpriv.xyz](https://webrtc.inpriv.xyz) — real-IP leak detection
- **Pay** — [pay.inpriv.xyz](https://pay.inpriv.xyz) — crypto payment bridge
- **Hash** — [hash.inpriv.xyz](https://hash.inpriv.xyz) — SHA & MD5 checksums, in-browser
- **DNS Leak** — [dns.inpriv.xyz](https://dns.inpriv.xyz) — DNS audit over DoH
- **QR** — [qr.inpriv.xyz](https://qr.inpriv.xyz) — generate & read QR codes, offline
- **Keyring** — [keyring.inpriv.xyz](https://keyring.inpriv.xyz) — zero-knowledge secret vault
- **IP Info** — [ipinfo.inpriv.xyz](https://ipinfo.inpriv.xyz) — what your browser reveals
- **Brute** — [brute.inpriv.xyz](https://brute.inpriv.xyz) — hash brute-force matcher

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23d29922' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpolyline points='12 6 12 12 16 14'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> In Development

- **Mail** · **Zero** (wallet) · **OSINT** · **TOTP** · **Pass** · **Base64** · **Burn** · **Hexa** · **Verdant**

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Security

- **Key exchange** — Curve25519 (X25519 ECDH)
- **Encryption** — AES-256-GCM
- **Key derivation** — HKDF-SHA-256 + PBKDF2 (100k iterations)
- **Randomness** — Web Crypto API (`crypto.getRandomValues()`)
- **Transport** — TLS 1.3 (Hush signaling: `wss://`)
- **CSP** — `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`

**Guarantees:** ✓ client-side only · ✓ forward secrecy · ✓ zero metadata · ✓ open source

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Tech Stack

- **Frontend** — vanilla HTML/CSS/JS, Material Design 3 (earthy forest)
- **Crypto** — Web Crypto API, Curve25519
- **Hush signaling** — Python WebSocket server
- **Swift editor** — Rust
- **Edge** — Cloudflare (TLS, DDoS protection)

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z'/%3E%3Cpath d='M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z'/%3E%3Cpath d='M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0'/%3E%3Cpath d='M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Getting Started

```bash
git clone https://github.com/salo-yek/inpriv.git
cd inpriv

# Serve locally (any static server works)
python -m http.server 8080
# → http://localhost:8080
```

Run your own Hush signaling relay:

```bash
cd .hush
pip install -r requirements.txt
python server.py
```

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Project Structure

<details>
<summary>Click to expand — full monorepo layout</summary>

```
inpriv/
├── index.html          # Suite landing page (inpriv.xyz)
├── LICENSE             # MIT
├── .hush/              # E2E chat — web app + signaling server
├── .wipe/              # Metadata sanitizer
├── .compress/          # Image compression
├── .webrtc/            # WebRTC leak test
├── .pay/               # Crypto payment bridge
├── .hash/              # Checksum generator
├── .dns/               # DNS leak test (DoH)
├── .qr/                # QR generator/reader
├── .keyring/           # Encrypted secret vault
├── .ipinfo/            # Browser fingerprint inspector
├── .brute/             # Hash brute-force matcher
├── .zero/              # Crypto wallet (WIP)
├── .osint/             # OSINT engine (WIP)
├── .mail/              # Disposable email (WIP)
├── .totp/              # TOTP generator (WIP)
├── .hexa/              # In development
├── .verdant/           # In development
├── ..swift/            # inpriv-swift — Rust text editor
└── .cftcfg/            # Cloudflare Tunnel config manager
```

</details>

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolygon points='1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6'/%3E%3Cline x1='8' y1='2' x2='8' y2='18'/%3E%3Cline x1='16' y1='6' x2='16' y2='22'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Roadmap

- [x] 11 core tools live on production
- [ ] PWA + offline support
- [ ] TOTP, Pass, Base64 — quick wins
- [ ] Burn — ephemeral encrypted notes
- [ ] Zero wallet — security audit before release
- [ ] Mail — encrypted disposable email
- [ ] OSINT — AI-powered intelligence engine
- [ ] Security headers + SRI hardening
- [ ] i18n (PL/EN)

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='9' cy='7' r='4'/%3E%3Cpath d='M23 21v-2a4 4 0 0 0-3-3.87'/%3E%3Cpath d='M16 3.13a4 4 0 0 1 0 7.75'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> Contributing

1. **No malicious features** — modules enabling unauthorized access will be rejected
2. **Privacy by design** — nothing may ever phone home
3. Open an issue first for big changes
4. Follow the existing M3 design tokens

---

## <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237d8590' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/%3E%3Cpolyline points='14 2 14 8 20 8'/%3E%3Cline x1='16' y1='13' x2='8' y2='13'/%3E%3Cline x1='16' y1='17' x2='8' y2='17'/%3E%3Cpolyline points='10 9 9 9 8 9'/%3E%3C/svg%3E" width="18" height="18" align="center" alt=""> License

MIT © 2026 [Aurex Labs](https://aurexlabs.xyz)

---

<div align="center">

<img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ABD37A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z'/%3E%3C/svg%3E" width="14" height="14" alt=""> Built with love and paranoia — by **Aurex Labs**, independent studio

</div>
