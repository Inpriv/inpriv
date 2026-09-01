# Inpriv Hash — Checksum & Digest

> Compute cryptographic digests of any text or file — SHA-1, SHA-256, SHA-384, SHA-512 and MD5 — entirely in your browser. Nothing is uploaded.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Hash computes multiple checksums simultaneously for any text or file input. It outputs MD5, SHA-1, SHA-256, SHA-384, and SHA-512 digests, and includes a verification field to compare a pasted expected hash against all computed digests. Files are read in chunks for progress feedback, and nothing is ever uploaded.

## Features

- **Five algorithms** — MD5, SHA-1, SHA-256, SHA-384, SHA-512 (all computed in parallel)
- **Text and file modes** — toggle between typing/pasting text or dropping a file
- **Chunked file reading** — 4 MB chunks with progress bar for large files
- **Hash verification** — paste an expected checksum; auto-matches against any computed digest
- **Copy individual or all** — per-hash copy buttons plus a "Copy All" toolbar action
- **JSON report export** — full report (source, size, all digests) copied to clipboard
- **Live byte/char count** — UTF-8 aware byte counting for text mode
- **Dark/light theme** toggle with system preference detection

## How it works

SHA family hashes use the native **Web Crypto API** (`crypto.subtle.digest()`), which runs in the browser's native cryptographic implementation. MD5 (not available in Web Crypto) is computed via a self-contained, dependency-free pure-JavaScript implementation of RFC 1321 bundled inline. All five digests are computed in parallel via `Promise.all()`. For files, data is read in 4 MB chunks using `File.slice()` + `arrayBuffer()`, concatenated into a single `Uint8Array`, then hashed. Text input is encoded to UTF-8 via `TextEncoder`. Results are displayed as uppercase hex strings.

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.hash/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no data leaves the browser
- ✅ Uses native Web Crypto API (`crypto.subtle`) for SHA algorithms
- ✅ MD5 implemented in pure JS (no external dependency for it)
- ✅ All dynamic output uses `textContent` (no `innerHTML` with user input)
- ✅ No `eval()`, no hardcoded secrets, no external JS dependencies
- ⚠️ External favicon referenced from `hush.best`
- ⚠️ External font dependencies (Google Fonts)
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Inpriv Labs Design System)
- Web Crypto API (`crypto.subtle.digest`) for SHA-1/256/384/512
- Bundled pure-JS MD5 (RFC 1321)
- Roboto Flex + Material Symbols Rounded (Google Fonts)
