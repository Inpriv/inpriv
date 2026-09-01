# Inpriv Wipe — Metadata Inspector & Sanitizer

> Zero-knowledge local metadata inspector and sanitizer. See exactly what your photos leak — then wipe it. 100% client-side. No data leaves your device.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

Live at [wipe.inpriv.xyz](https://wipe.inpriv.xyz).

## What it does

Drop in a photo and Wipe immediately renders a **full metadata report**: every EXIF tag (named, human-formatted), GPS coordinates decoded to decimal degrees with an OpenStreetMap link, plus container-level blocks that most tools miss — XMP, IPTC/Photoshop, ICC profiles, JPEG comments, PNG `tEXt`/`iTXt`/`eXIf` chunks, WebP EXIF/XMP chunks. Each file gets a sensitivity classification (Location / Timestamp / Device / Serial / Author / XMP / IPTC chips) so it's obvious what would identify you.

Beyond inspection, three processing modes: **Total Purge** (destroys all metadata, then re-scans the output to verify nothing remains), **Ghost** (replaces metadata with synthetic, randomized camera fingerprints) and **Architect** (injects custom metadata fields like camera make, model, software, and copyright). No image data is ever uploaded to a server.

## Features

- **Instant metadata report** — upload and see every tag before deciding anything
  - Full EXIF dump with real tag names (Image / Photo / GPS groups), rationals formatted (`1/250 s`, `f/2.8`, `50 mm`), `XP_*` UTF-16 Windows tags decoded
  - GPS → decimal degrees + altitude + one-tap OpenStreetMap pin
  - Container scan: XMP, IPTC, ICC, JPEG comments, PNG text/eXIf chunks, WebP chunks
  - Sensitivity chips: Location, Timestamp, Device, Serial No., Author, Software, XMP, IPTC
- **Image thumbnails** and dimensions in every file card
- **Wipe mode** — strips EXIF via `piexif.remove()`, and when stubborn blocks (XMP/ICC/IPTC/comments) survive, re-encodes through `<canvas>` to destroy them; output is **re-scanned and verified clean**
- **Ghost mode** — rewrites metadata with randomized synthetic camera fingerprints and synthetic timestamps (up to 180 days in the past)
- **Architect mode** — injects custom metadata (make, model, software, copyright)
- **Batch processing** — queue multiple files and process them sequentially with progress feedback
- **Multi-format support** — JPEG, PNG, TIFF, WebP (non-JPEG formats are rasterized to JPEG via `<canvas>`); `imageOrientation: 'from-image'` keeps EXIF-rotated phone photos upright
- **Mobile-first UI** — thumb-friendly bottom nav, snap-scroll mode rail, safe-area insets, 44px touch targets, 16px inputs (no iOS zoom), back button on subviews; sidebar layout on ≥600px
- **Drag-and-drop** upload with file validation (`accept="image/*"` — full camera roll on mobile)
- **Dark/light theme** toggle, persisted via `localStorage` (`inpriv_theme`)

## How it works

All processing happens client-side. Images are read as data URLs via `FileReader` and as raw bytes via `file.arrayBuffer()`. The raw bytes are walked with a small container parser (JPEG APPn/COM segments, PNG chunk table, RIFF/WebP chunk table) to find every metadata block; EXIF contents are parsed with [piexifjs](https://github.com/hMatyushkin/piexifjs) (loaded from CDN with SRI, MIT-licensed). Non-JPEG images are rasterized to JPEG on an offscreen `<canvas>` (flattening alpha to white) before EXIF operations. Ghost mode constructs a fresh EXIF object with randomized values from an embedded camera database and inserts it via `piexif.insert()`. After a purge, the output bytes are re-scanned and the card shows a "verified clean" badge or per-block warnings. Results are presented as downloadable data URLs.

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.wipe/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no data leaves the browser (`connect-src 'self'` in CSP)
- ✅ User input (filenames, tag values) is escaped via `escapeHtml()` before DOM insertion
- ✅ piexifjs CDN script loaded with SRI `integrity` + `crossorigin`
- ✅ CSP `<meta>`: `object-src 'none'`, `frame-src 'none'`, locked `connect-src`
- ✅ No hardcoded secrets or API keys
- ⚠️ Depends on external CDN: `piexifjs@1.0.6` from jsdelivr
- ⚠️ OpenStreetMap links open externally (user-initiated only)

## Tech

- Vanilla HTML/CSS/JS — single self-contained `index.html`
- Material Design 3 (Inpriv Labs Design System, Earthy Forest)
- piexifjs (CDN) for EXIF manipulation
- Roboto Flex + Material Symbols Rounded (Google Fonts)
