# Inpriv Brute

> Client-side hash brute-force matcher for educational password-security demonstrations.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Brute is a dictionary-attack matcher that takes a target hash and a wordlist, then computes the hash of every word in the list until it finds a match. It supports **MD5, SHA-1, SHA-256, SHA-384, and SHA-512** with auto-detection by hash length. All computation runs entirely in your browser — nothing is sent anywhere. The tool is explicitly for educational purposes: understanding why weak, common passwords are trivially crackable.

## Features

- **Five hash algorithms**: MD5 (pure-JS implementation), SHA-1/256/384/512 (Web Crypto API)
- **Auto-detect** hash type by length (32/40/64/96/128 hex chars), or manually select / try-all
- **Plaintext-password suggestion**: if you paste a password instead of a hash, offers clickable buttons to convert it to each hash format
- **Three wordlist sources**:
  - **Inline textarea** — type or paste words (one per line)
  - **Preset lists** — "Top 100 Common" and "Top 100 RockYou" built-in
  - **File upload** — `.txt`/`.csv`/`.lst` files; files over 2 MB are **streamed line-by-line** to avoid loading them into memory
- **Streaming engine**: large files are read as async iterables via `file.stream()`, never held in memory entirely
- **Live progress**: progress bar, elapsed time, hash rate (h/s), entries checked / total
- **Responsive UI**: yields to the event loop (~20×/s) so the tab stays usable during long runs
- **Cancel** mid-run, **Clear** all inputs
- **Match found** state with copy-to-clipboard; **no match** state with stats
- **Light/dark theme** (defaults to dark), persisted in localStorage

## How it works

1. **MD5** (`md5()`): A self-contained, RFC 1321-compliant pure-JavaScript implementation (no external library). Operates on `Uint8Array` input.
2. **SHA family** (`sha()`): Uses `crypto.subtle.digest()` for SHA-1/256/384/512. Output is converted to lowercase hex.
3. **Hash detection** (`detectHashType()`): Checks if input is valid hex and matches a known length → algorithm mapping.
4. **Word sources**: Both inline (textarea/preset arrays) and streamed (large files) are exposed as async iterables yielding `Uint8Array` word-bytes, so the cracking loop is source-agnostic.
5. **Streaming** (`streamLines()`): Uses the File Stream API (`file.stream().getReader()`) to read chunks, split on newlines (`0x0A`), trim whitespace, and yield each line as raw bytes — with a progress callback for bytes read.
6. **Cracking loop** (`crackHash()`): Iterates the word source, computes each algorithm's hash, compares against the target (both lowercase hex). Yields to the UI every 50ms via `setTimeout(0)` for repaints and cancel handling.

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.brute/index.html
```

> A local server (not `file://`) is required so the Web Crypto API is available.

## Security

- ✅ Client-side only — no network requests; all hashing happens in-browser
- ✅ All dynamic output uses `esc()` before `innerHTML` insertion
- ✅ Large files are streamed, not loaded into memory
- ⚠️ **For educational purposes only** — demonstrates why weak passwords are vulnerable to dictionary attacks; do not use against hashes you do not own
- ℹ️ `rockyou.txt` is gitignored (not included in the repo); preset wordlists contain only the top 100 entries each
- ℹ️ One `console.error` call for stream-read failures (error logging, no sensitive data)
- ℹ️ External dependencies: Google Fonts (Roboto Flex, Material Symbols Rounded) and favicon from `hush.best`

## Tech

- Vanilla HTML/CSS/JS (single `index.html`, no build step)
- Web Crypto API (`crypto.subtle.digest`) for SHA family
- Pure-JS MD5 implementation (RFC 1321)
- File Stream API for memory-efficient large-file processing
- Material Design 3 (Aurex Labs Design System — Earthy Forest)
