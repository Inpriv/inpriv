<div align="center">

# 🔐 Inpriv

### Zero-knowledge. Client-side only.

**A suite of privacy-first web utilities engineered for total digital privacy.**

No trackers. No remote logs. No compromises — everything runs in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-inpriv.xyz-466E47)](https://inpriv.xyz)
[![Tools](https://img.shields.io/badge/tools-11%20live%20%2B%207%20coming%20soon-ABD37A)](https://inpriv.xyz)
[![Zero-Knowledge](https://img.shields.io/badge/zero--knowledge-%E2%9C%93-C7EFA0)]()
[![By Aurex Labs](https://img.shields.io/badge/by-Aurex%20Labs-9C4231)]()

</div>

---

## 🧭 Overview

Inpriv is an ecosystem of **zero-knowledge, fully client-side web utilities**. Every tool is engineered so that your sensitive data **never leaves your device** — no accounts, no servers, no telemetry, no log files. What happens in your browser, stays in your browser.

> **Why "zero-knowledge"?** Because the system — by design — holds *zero* knowledge about you. There is nothing to leak, nothing to subpoena, nothing to sell.

---

## 🟢 Live Tools

- **Hush** — [hush.best](https://hush.best) — end-to-end encrypted chat. No logs, no servers. Forward-secret rooms, QR sharing, zero metadata
- **Wipe** — [wipe.inpriv.xyz](https://wipe.inpriv.xyz) — zero-knowledge metadata (EXIF/GPS) sanitizer for images
- **Compress** — [compress.inpriv.xyz](https://compress.inpriv.xyz) — client-side image compression — no uploads, ever
- **WebRTC Leak** — [webrtc.inpriv.xyz](https://webrtc.inpriv.xyz) — detect if your real IP leaks via WebRTC
- **Pay** — [pay.inpriv.xyz](https://pay.inpriv.xyz) — crypto payment bridge for accepting payments
- **Hash** — [hash.inpriv.xyz](https://hash.inpriv.xyz) — SHA & MD5 checksums for any text or file, in-browser
- **DNS Leak** — [dns.inpriv.xyz](https://dns.inpriv.xyz) — browser-side DNS resolution audit over DoH
- **QR** — [qr.inpriv.xyz](https://qr.inpriv.xyz) — generate & read QR codes — camera or image, fully offline
- **Keyring** — [keyring.inpriv.xyz](https://keyring.inpriv.xyz) — zero-knowledge encrypted vault for SSH keys, tokens, passwords
- **IP Info** — [ipinfo.inpriv.xyz](https://ipinfo.inpriv.xyz) — see exactly what your browser reveals — IP, ISP, fingerprint
- **Brute** — [brute.inpriv.xyz](https://brute.inpriv.xyz) — hash brute-force matcher — MD5, SHA-1, SHA-256, SHA-384, SHA-512

## 🟡 In Development

- **Mail** — encrypted, disposable email forwarding
- **Zero** — private, self-custodial crypto wallet
- **OSINT** — AI-powered open-source intelligence
- **TOTP** — time-based one-time password generator
- **Pass** — offline cryptographic password generator
- **Base64** — Base64, URL & HTML encoder/decoder
- **Burn** — ephemeral encrypted notes — read once, destroyed
- **Hexa** — *new, in active development*
- **Verdant** — *new, in active development*

---

## 🔒 Security

- **Key exchange** — Curve25519 (X25519 ECDH)
- **Symmetric encryption** — AES-256-GCM
- **Key derivation** — HKDF-SHA-256 + PBKDF2 (100k iterations)
- **Randomness** — `crypto.getRandomValues()` / Web Crypto API
- **Transport** — TLS 1.3 via Cloudflare (Hush signaling: `wss://`)
- **CSP** — `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`

**Design guarantees:**

- ✅ **Client-side only** — crypto never touches a server
- ✅ **Forward secrecy** — per-message keys (Hush)
- ✅ **Zero metadata** — no logs, no IP retention, no analytics
- ✅ **Open source** — audit the code yourself

---

## 🛠️ Tech Stack

- **Frontend** — vanilla HTML/CSS/JS, Material Design 3 (earthy forest)
- **Crypto** — Web Crypto API, Curve25519 (hand-rolled, audited)
- **Hush signaling** — Python WebSocket server (`server.py`)
- **Swift editor** — Rust (`..swift/`)
- **Edge** — Cloudflare (TLS, DDoS protection)

---

## 🚀 Getting Started

All tools are **static single-page apps** — open them and go:

```bash
# Clone the monorepo
git clone https://github.com/salo-yek/inpriv.git
cd inpriv

# Serve locally (any static server works)
python -m http.server 8080
# → http://localhost:8080
```

**Hush server** (run your own signaling relay):

```bash
cd .hush
pip install -r requirements.txt
python server.py
```

---

## 🗂️ Project Structure

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

---

## 🗺️ Roadmap

- [x] 11 core tools live on production
- [ ] PWA + offline support — all tools installable, work offline
- [ ] TOTP, Pass, Base64 — quick wins, fully client-side
- [ ] Burn — ephemeral encrypted notes (E2E link-based keys)
- [ ] Zero wallet — security audit before public release
- [ ] Mail — encrypted disposable email
- [ ] OSINT — AI-powered intelligence engine
- [ ] Security headers + SRI hardening pass
- [ ] i18n (PL/EN)

---

## 🤝 Contributing

Inpriv is open source and contributions are welcome:

1. **No malicious features** — modules enabling unauthorized access will be rejected
2. **Privacy by design** — nothing may ever phone home
3. Open an issue first for big changes
4. Follow the existing M3 design tokens for UI work

---

## 📄 License

MIT © 2026 [Aurex Labs](https://aurexlabs.xyz)

---

<div align="center">

**Built with ❤️ and paranoia**

by **Aurex Labs** — independent studio crafting privacy, performance & precision tools

</div>
