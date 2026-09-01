# Inpriv Keyring

> Zero-knowledge encrypted secret vault for SSH keys, API tokens, passwords and notes.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Keyring is a client-side encrypted vault that stores SSH keys, API tokens, passwords and secure notes entirely in your browser. Everything is encrypted with **AES-256-GCM** using a key derived from your master password via **PBKDF2-SHA256 (600,000 iterations)**. The master password never leaves your device and cannot be recovered — if you forget it, your data is gone.

## Features

- **Four entry types**: passwords, API tokens, SSH keys, and secure notes — each with its own icon and color
- **AES-256-GCM encryption** with a PBKDF2-derived key (600k iterations, 16-byte random salt, 12-byte IV)
- **Password-based verifier**: a known constant is encrypted alongside your data so the vault can validate the master password without ever storing it
- **Password strength meter** with real-time scoring (length, character sets, repetition penalties)
- **Auto-lock after 5 minutes** of inactivity — clears the decrypted key and entries from memory
- **Search and filter** entries by name, notes, and type
- **Masked values** with reveal toggle; clipboard auto-clears after 30 seconds
- **Encrypted backup export** — portable JSON containing the salt, verifier, and ciphertext blob (stays encrypted with your current key)
- **Plaintext export** (with confirmation warning) for migration
- **Import encrypted backup** to restore a vault on a new device
- **Wipe vault** with master-password confirmation
- **Light/dark theme** (defaults to dark), persisted in localStorage

## How it works

1. **Key derivation**: On vault creation, a 16-byte random salt is generated. The master password is fed through `PBKDF2-SHA256` with 600,000 iterations to derive a 256-bit `AES-GCM` key via the Web Crypto API (`crypto.subtle`).
2. **Verifier**: A known plaintext constant (`inpriv-keyring-v1-verifier`) is encrypted and stored. On unlock, the derived key attempts to decrypt the verifier — success confirms the password without storing it anywhere.
3. **Data blob**: All entries are serialized to JSON and encrypted with AES-256-GCM using a fresh 12-byte random IV per encryption. The stored shape is `{ salt, verifier, blob, created, v }`.
4. **Session**: The derived key lives only in memory (`session.key`) while unlocked. On lock (manual or auto-timeout), the key and decrypted entries are zeroed out.
5. **Storage**: Everything persists in `localStorage` under `inpriv_keyring_v1`.

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.keyring/index.html
```

> A local server (not `file://`) is required so the Web Crypto API is available.

## Security

- ✅ Client-side only — no network requests for data storage or encryption
- ✅ AES-256-GCM authenticated encryption via `crypto.subtle`
- ✅ PBKDF2-SHA256 with 600,000 iterations (OWASP-recommended minimum for SHA-256)
- ✅ Random salt and IV per encryption; master password never stored or transmitted
- ✅ Clipboard auto-clears after 30 seconds
- ✅ Auto-lock on 5-minute idle
- ⚠️ Single-page HTML (no external JS frameworks); HTML output uses an `esc()` helper to escape user input before `innerHTML` insertion
- ℹ️ All vault data stored in `localStorage` (encrypted) — clearing browser data removes the vault
- ℹ️ External dependencies: Google Fonts (Roboto Flex, Material Symbols Rounded) and favicon from `hush.best` — these are for typography/icons only and receive no user data

## Tech

- Vanilla HTML/CSS/JS (single `index.html`, no build step)
- Web Crypto API (`crypto.subtle`)
- Material Design 3 (Inpriv Labs Design System — Earthy Forest)
