# Inpriv Hexa

> Privacy-focused hexagonal code generator — turn any text into a one-of-a-kind honeycomb pattern.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Hexa is an aesthetic generative-art tool that hashes your text into a deterministic seed and renders a symmetric honeycomb pattern inside a single large hexagon silhouette. It supports URL, Wi-Fi, plain text, vCard, and AES-GCM encrypted note content types, with extensive customization (pattern style, colors, size, rounding, logo). Export to SVG, high-res PNG, or print-ready PDF. Everything runs locally — nothing is uploaded.

> **Note:** This produces decorative generative art, not a scannable QR/barcode. The same input always yields the same artwork.

## Features

- **Five content presets**: URL, Wi-Fi (ZXing grammar), plain Text, vCard 3.0, Encrypted Note (AES-GCM, PBKDF2 100k iterations)
- **Four pattern styles**: Crystal (radial falloff), Spiral (angular arms), Rings (concentric), Cluster (organic blobs)
- **Full customizer**: hexagon size (Small/Medium/Large → 61/127/217 cells), outline width, cell fill ratio, corner rounding
- **Color system**: 6 curated Earthy Forest palettes + individual primary/accent/surface color pickers
- **Center logo**: toggle on/off, upload SVG or PNG (max 1.5 MB)
- **Live preview** with cell count, size, style, and character count metadata
- **Export**: SVG (vector), PNG (4× high-res), PDF (print-ready, JPEG-embedded, hand-assembled)
- **Copy SVG** to clipboard, **Share** via Web Share API (with clipboard fallback)
- **Light/dark theme** — defaults to dark (privacy-first), persists choice, honors `prefers-color-scheme` until you pick one
- **Accessible**: ARIA roles, focus-visible rings, `prefers-reduced-motion` support, 40px+ touch targets
- **Responsive**: vertical stack on mobile, side-by-side workspace on desktop

## How it works

1. **Seeded PRNG** (`makeRng()`): Your text seeds an `xmur3` hash function, which seeds an `sfc32` PRNG — so identical input always produces identical random values.
2. **Hexagon grid** (`bigHexCellList()`): An axial-coordinate (q,r) honeycomb is generated. The density slider maps to a hexagon "radius" of 4, 6, or 8 cells, yielding 61, 127, or 217 total cells.
3. **Pattern generation**: Each style decides which cells are "on." Patterns are computed on one half (q ≥ 0) and **mirrored** to the other half for guaranteed left/right symmetry.
4. **Accent coloring**: A few seed-picked "on" cells (away from center) use the accent color so the primary dominates but the piece has visual life.
5. **SVG rendering**: Rounded-hexagon polygons are emitted as SVG `<path>` or `<use>` elements with per-cell animation delays (when cell count ≤ 600).
6. **Encrypted notes** (`Presets.note()`): Passphrase derives a 256-bit AES-GCM key via PBKDF2-SHA256 (100k iterations); the note is encrypted and encoded as `INAES1:` + base64(salt|iv|ciphertext).
7. **Export pipeline** (`export.js`): SVG is serialized; PNG rasters via canvas at 4× scale; PDF is hand-assembled (no library) embedding a JPEG via DCTDecode stream.

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.hexa/index.html
```

> A local server (not `file://`) is recommended so Web Crypto, clipboard, and export APIs are available.

## Security

- ✅ Client-side only — all generation, encryption, and rendering happen in-browser; nothing is transmitted
- ✅ Encrypted notes use AES-256-GCM with PBKDF2 key derivation; passphrase never leaves the device
- ✅ No `eval()`, no user input in `innerHTML` without escaping
- ✅ Logo uploads validated to SVG/PNG only, capped at 1.5 MB
- ℹ️ PDF export uses a hand-written PDF assembler (no external PDF library)
- ℹ️ External dependencies: Google Fonts (Roboto Flex, Material Symbols Rounded) only — no JS CDNs
- ℹ️ `localStorage` used only for theme preference

## Tech

- Vanilla HTML/CSS/JS (modular `js/` directory, no build step)
- Web Crypto API (`crypto.subtle`) for encrypted notes
- Deterministic PRNG (xmur3 → sfc32)
- SVG-based rendering (no canvas for the art itself)
- Material Design 3 (Inpriv Labs Design System — Earthy Forest)
