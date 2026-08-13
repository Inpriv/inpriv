# Verdant

> Base64 encoder/decoder for the web — fully client-side.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Verdant is a Base64 encoding/decoding tool that handles text and files entirely in your browser. No data is uploaded to any server — all encoding and decoding happens locally via the browser's native APIs.

## Features

- **Text encoding/decoding** — encode strings to Base64 and decode back
- **File encoding** — drag & drop files to get their Base64 representation
- **Image preview** — decodes Base64 image data and shows a live preview
- **Batch mode** — process multiple files at once
- **Copy to clipboard** — one-click copy of results
- **Dark/light theme** — follows the Aurex Labs Design System
- **Responsive** — works on mobile and desktop

## How it works

All operations use the browser's native `atob()`, `btoa()`, and `FileReader` APIs. File reading uses `FileReader.readAsDataURL()` for Base64 conversion. No data ever leaves the browser — there are no network requests during encoding or decoding.

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.verdant/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no data leaves the browser
- ✅ No external API calls
- ✅ No localStorage of encoded data (ephemeral)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Aurex Labs Design System)
- Google Fonts (Roboto Flex, Roboto Mono)
