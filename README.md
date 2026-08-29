<div align="center">

<img src="icon.png" width="72" height="72" alt="Inpriv logo">

# Inpriv

### Zero-knowledge. Client-side only.

**A suite of privacy-first web utilities engineered for total digital privacy.**

No trackers. No remote logs. No compromises — everything runs in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-inpriv.xyz-466E47)](https://inpriv.xyz)
[![Tools](https://img.shields.io/badge/tools-16%20live%20%2B%206%20in%20dev-ABD37A)](https://inpriv.xyz)
[![Zero-Knowledge](https://img.shields.io/badge/zero--knowledge-%E2%9C%93-C7EFA0)]()
[![By Aurex Labs](https://img.shields.io/badge/by-Aurex%20Labs-9C4231)]()

<img src="assets/icons/link.svg" width="14" height="14" alt=""> Quick links: [Website](https://inpriv.xyz) · [License](LICENSE) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## <img src="assets/icons/compass.svg" width="18" height="18" align="center" alt=""> Overview

Inpriv is an ecosystem of **zero-knowledge, fully client-side web utilities** — engineered so your sensitive data **never leaves your device**. No accounts, no servers, no telemetry, no log files. What happens in your browser, stays in your browser.

> **Why "zero-knowledge"?** Because the system — by design — holds *zero* knowledge about you. There is nothing to leak, nothing to subpoena, nothing to sell.

---

## <img src="assets/icons/check-circle.svg" width="18" height="18" align="center" alt=""> Live Tools

- **Hush** — [hush.best](https://hush.best) — E2E encrypted chat. Forward-secret rooms, QR sharing, zero metadata
- **Wipe** — [wipe.inpriv.xyz](https://wipe.inpriv.xyz) — metadata (EXIF/GPS) sanitizer for images
- **Compress** — [compress.inpriv.xyz](https://compress.inpriv.xyz) — image compression, no uploads
- **Trace** — [trace.inpriv.xyz](https://trace.inpriv.xyz) — one scan: IP & ISP intel, DNS leak test, WebRTC leak check
- **Pay** — [pay.inpriv.xyz](https://pay.inpriv.xyz) — crypto payment bridge
- **Host** — [host.inpriv.xyz](https://host.inpriv.xyz) — private static file hosting (Google Drive) with IP-logger/WebRTC-leak scan before publish
- **Hash** — [hash.inpriv.xyz](https://hash.inpriv.xyz) — SHA & MD5 checksums, in-browser
- **QR** — [qr.inpriv.xyz](https://qr.inpriv.xyz) — generate & read QR codes, offline
- **Keyring** — [keyring.inpriv.xyz](https://keyring.inpriv.xyz) — zero-knowledge secret vault
- **Brute** — [brute.inpriv.xyz](https://brute.inpriv.xyz) — hash brute-force matcher
- **TOTP** — [totp.inpriv.xyz](https://totp.inpriv.xyz) — RFC 6238 authenticator, encrypted vault
- **Burn** — [burn.inpriv.xyz](https://burn.inpriv.xyz) — ephemeral encrypted notes, read-once
- **Stego** — [stego.inpriv.xyz](https://stego.inpriv.xyz) — hide AES-256 encrypted messages inside PNG images
- **Temp** — [temp.inpriv.xyz](https://temp.inpriv.xyz) — disposable email addresses, live inbox, one-click shred
- **Censor** — [censor.inpriv.xyz](https://censor.inpriv.xyz) — blur/pixelate faces, cards, IPs & tokens on screenshots (on-device auto-detect)

## <img src="assets/icons/clock.svg" width="18" height="18" align="center" alt=""> In Development

- **Mail** · **Zero** (wallet) · **OSINT** · **Hexa** · **Verdant**

---

## <img src="assets/icons/lock.svg" width="18" height="18" align="center" alt=""> Security

- **Key exchange** — Curve25519 (X25519 ECDH)
- **Encryption** — AES-256-GCM
- **Key derivation** — HKDF-SHA-256 + PBKDF2 (100k iterations)
- **Randomness** — Web Crypto API (`crypto.getRandomValues()`)
- **Transport** — TLS 1.3 (Hush signaling: `wss://`)
- **CSP** — `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`

**Guarantees:** ✓ client-side only · ✓ forward secrecy · ✓ zero metadata · ✓ open source

---

## <img src="assets/icons/wrench.svg" width="18" height="18" align="center" alt=""> Tech Stack

- **Frontend** — vanilla HTML/CSS/JS, Material Design 3 (earthy forest)
- **Crypto** — Web Crypto API, Curve25519
- **Hush signaling** — Python WebSocket server
- **Swift editor** — Rust
- **Edge** — Cloudflare (TLS, DDoS protection)

---

## <img src="assets/icons/rocket.svg" width="18" height="18" align="center" alt=""> Getting Started

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

## <img src="assets/icons/folder.svg" width="18" height="18" align="center" alt=""> Project Structure

<details>
<summary>Click to expand — full monorepo layout</summary>

```
inpriv/
├── index.html          # Suite landing page (inpriv.xyz)
├── LICENSE             # MIT
├── .hush/              # E2E chat — web app + signaling server
├── .censor/            # Screenshot redactor (blur/pixelate + face/OCR auto-detect)
├── .wipe/              # Metadata sanitizer
├── .compress/          # Image compression
├── .trace/             # IP + DNS + WebRTC leak test (one scan)
├── .host/              # private static hosting — Google Drive + privacy shield
├── .pay/               # Crypto payment bridge
├── .hash/              # Checksum generator
├── .webrtc/            # redirects to trace.inpriv.xyz
├── .qr/                # QR generator/reader
├── .keyring/           # Encrypted secret vault
├── .dns/               # redirects to trace.inpriv.xyz
├── .ipinfo/            # redirects to trace.inpriv.xyz
├── .brute/             # Hash brute-force matcher
├── .stego/             # LSB steganography — hide encrypted messages in PNGs
├── .temp/              # disposable email — random @inpriv.xyz inboxes, Resend inbound
├── .admin/             # admin dashboard — admin.inpriv.xyz (TOTP login, kill-switches)
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

## <img src="assets/icons/map.svg" width="18" height="18" align="center" alt=""> Roadmap

- [x] 16 core tools live on production
- [ ] PWA + offline support
- [ ] Zero wallet — security audit before release
- [ ] Mail — encrypted disposable email
- [ ] OSINT — AI-powered intelligence engine
- [ ] Security headers + SRI hardening
- [ ] i18n (PL/EN)

---

## <img src="assets/icons/users.svg" width="18" height="18" align="center" alt=""> Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for full guidelines.

1. **No malicious features** — modules enabling unauthorized access will be rejected
2. **Privacy by design** — nothing may ever phone home
3. Open an issue first for big changes
4. Follow the existing M3 design tokens

Found a security issue? See **[SECURITY.md](SECURITY.md)**.

---

## <img src="assets/icons/file-text.svg" width="18" height="18" align="center" alt=""> License

MIT © 2026 [Aurex Labs](https://aurexlabs.xyz)

---

<div align="center">

<img src="assets/icons/heart.svg" width="14" height="14" alt=""> Built with love and paranoia — by **Aurex Labs**, independent studio

</div>
