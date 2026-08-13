# Inpriv Wipe — Metadata Sanitizer

> Zero-knowledge local metadata sanitizer. 100% client-side. No data leaves your device.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Wipe strips EXIF/IPTC/XMP metadata from JPEG, PNG, TIFF, and WebP images entirely in the browser. Beyond simple stripping, it offers two advanced modes: **Ghost** (replaces metadata with synthetic, randomized camera fingerprints) and **Architect** (injects custom metadata fields like camera make, model, software, and copyright). No image data is ever uploaded to a server.

## Features

- **Wipe mode** — purges all EXIF/GPS metadata via `piexif.remove()`
- **Ghost mode** — rewrites metadata with randomized synthetic camera fingerprints (from a built-in camera database) and synthetic timestamps
- **Architect mode** — injects custom metadata (make, model, software, copyright)
- **Batch processing** — queue multiple files and process them sequentially with progress feedback
- **Multi-format support** — JPEG, PNG, TIFF, WebP (non-JPEG formats are rasterized to JPEG via `<canvas>`)
- **EXIF summary** — previews detected metadata (make, model, date, GPS presence) before processing
- **Drag-and-drop** upload with file validation
- **Dark/light theme** toggle with system preference detection

## How it works

All processing happens client-side. Images are read as data URLs via `FileReader`. The [piexifjs](https://github.com/hMatyushkin/piexifjs) library (loaded from CDN, MIT-licensed) handles EXIF parsing, removal, and injection on JPEG data. Non-JPEG images are first rasterized to JPEG on an offscreen `<canvas>` (flattening alpha to white), then processed. Ghost mode constructs a fresh EXIF object with randomized values from an embedded camera database and inserts it via `piexif.insert()`. Results are presented as downloadable data URLs.

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.wipe/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no data leaves the browser
- ✅ User input (filenames) is escaped via `escapeHtml()` before DOM insertion
- ✅ No hardcoded secrets or API keys
- ⚠️ Depends on external CDN: `piexifjs@1.0.6` from jsdelivr (SRI hash not present — consider adding `integrity=""`)
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)
- ⚠️ External favicon/brand mark referenced from `hush.best`

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Aurex Labs Design System)
- piexifjs (CDN) for EXIF manipulation
- Roboto Flex + Material Symbols Rounded (Google Fonts)
