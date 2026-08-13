# Inpriv Compress — Image Compressor

> A modern, privacy-first, client-side image compressor by Aurex Labs.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Compress resizes and recompresses images entirely in the browser using an offscreen `<canvas>`. It outputs PNG, JPEG, WebP, or AVIF via `canvas.toBlob()`, with a live before/after comparison slider so you can see quality loss at any quality level. Pixels never leave the browser — there are no uploads.

## Features

- **Four output formats** — JPEG, WebP, PNG (lossless), and AVIF (with automatic browser support detection)
- **Quality slider** — adjustable 1–100% compression with real-time re-encoding
- **Before/after comparison** — draggable reveal slider with pointer + keyboard support
- **Live stats** — original size, compressed size, dimensions, and percentage saved
- **Alpha flattening** — transparent PNGs are composited onto white before JPEG encoding
- **Format fallback** — gracefully handles unsupported codecs with helpful error messages
- **Inline SVG icons** — icons render without external font dependencies (works offline)
- **Dark/light theme** toggle with `localStorage` persistence

## How it works

The tool loads an image into an `HTMLImageElement` via `URL.createObjectURL()`, then draws it at native resolution onto an offscreen `<canvas>`. `canvas.toBlob(format, quality)` performs the actual encoding using the browser's native codec. A 110ms debounce prevents excessive re-encoding while dragging the quality slider. The comparison viewer uses CSS `clip-path` on an overlay layer, with pointer events for dragging and arrow-key support for accessibility. Object URLs are revoked on each re-encode to prevent memory leaks.

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.compress/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no data leaves the browser
- ✅ No external JavaScript dependencies (only Google Fonts for typography)
- ✅ Uses `textContent` for all dynamic output (no `innerHTML` with user input)
- ✅ No `eval()`, no hardcoded secrets
- ⚠️ External favicon referenced from `hush.best`
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Aurex Labs Design System)
- Canvas API (`toBlob`) for encoding
- Inline SVG icon system (no icon font dependency)
- Roboto Flex (Google Fonts)
