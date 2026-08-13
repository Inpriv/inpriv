# Security Policy

## Reporting a Vulnerability

Inpriv is a privacy-first project — we take security reports seriously.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report privately:

1. **Email:** security@aurexlabs.xyz
2. **Subject:** `[SECURITY] Inpriv — <brief description>`
3. Include: description, steps to reproduce, impact assessment, and suggested fix (if any).

### Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix or mitigation | Within 30 days (severity-dependent) |
| Public disclosure | After fix is released, coordinated with reporter |

## Security Model

Inpriv tools are designed around **zero-knowledge architecture**:

- **Client-side only** — all cryptographic operations happen in your browser via the Web Crypto API
- **No servers processing your data** — static HTML/JS served from Cloudflare's edge
- **No telemetry, analytics, or tracking** — verified by design, not by promise
- **No accounts or databases** (except Hush signaling and Burn ephemeral notes, which store only encrypted blobs)

### Cryptographic Primitives

| Purpose | Algorithm |
|---------|-----------|
| Key exchange | X25519 (ECDH) |
| Symmetric encryption | AES-256-GCM |
| Key derivation | HKDF-SHA-256, PBKDF2 (100k iterations) |
| Wallet key derivation | BIP39 → BIP44 (Ed25519) |
| Wallet encryption | AES-256-GCM + Argon2id |
| Randomness | `crypto.getRandomValues()` / `crypto.subtle.generateKey()` |

### Modules with Server Components

| Module | What the server sees | What it never sees |
|--------|---------------------|-------------------|
| **Hush** (E2E chat) | Encrypted message routing, signaling | Plaintext, keys, metadata content |
| **Burn** (ephemeral notes) | Encrypted note blobs (auto-deleted) | Plaintext, encryption keys |
| **OSINT** (intelligence engine) | Query routing via SearXNG | Personal data about the user |

## Dependency Policy

- Minimize external dependencies — prefer vanilla browser APIs
- All dependencies are pinned in lockfiles
- Python backends use pinned versions in `requirements.txt`
- No CDN-loaded scripts at runtime (self-hosted fonts and assets only)

## Disclosure Credits

We credit security researchers who report valid vulnerabilities (unless they prefer to remain anonymous).

---

*Built with paranoia. © 2026 Aurex Labs.*
