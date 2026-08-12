# Inpriv Hexa

> Copyright (c) 2026 Aurex Labs — MIT License

A privacy-focused **hexagon art generator**. Type any text and it becomes a
one-of-a-kind honeycomb pattern — a pure hexagon design (no QR pixels, no
square grid). Built on Material Design 3 with the **Earthy Forest** aesthetic
(glassmorphism, warm off-whites, deep moss greens).

Everything runs locally in your browser. Nothing is uploaded.

> **Note:** This is decorative generative art, not a scannable code. Your text
> is hashed into a deterministic seed that paints a symmetric honeycomb inside a
> big hexagon silhouette — the same input always yields the same artwork.

## Features

- **Content presets**: URL, Wi-Fi, plain Text, vCard (contact), Encrypted Note
  - Encrypted notes use **AES-GCM** (PBKDF2 key derivation, 100k iterations).
- **Pattern styles**: Crystal, Spiral, Rings, Cluster — four distinct ways your
  text maps onto the honeycomb.
- **Customizer**:
  - Hexagon size slider (Small / Medium / Large)
  - Hexagon outline width, cell fill ratio, corner rounding
  - Primary / Accent / Surface color pickers with curated Earthy Forest palettes
  - Center logo toggle + SVG/PNG upload
- **Hex canvas**: a single large hexagon silhouette filled with pointy-top
  honeycomb cells, left/right symmetric, with a bouncy entrance animation.
- **Export**: SVG (vector), PNG (high-res 4×), PDF (print-ready, JPEG-embedded).
- **Copy to clipboard** (SVG), **Share** (Web Share API with fallback).
- **Light / dark theme** — defaults to dark, persists choice, honors
  `prefers-color-scheme` until you pick one.
- **Responsive** — vertical stack on mobile, side-by-side on desktop.
- **Accessible** — ARIA roles, focus-visible rings, `prefers-reduced-motion`
  support, 40px+ touch targets.

## How the pattern is made

1. Your text seeds a deterministic PRNG (xmur3 → sfc32), so identical input
   always paints identical art.
2. A big hexagonal grid ("hex of hexes") is generated — 61, 127, or 217 cells
   depending on the size setting.
3. The chosen style decides which cells light up, computed on one half and
   mirrored to the other for guaranteed symmetry.
4. A few seed-picked cells use the accent color so the primary dominates but
   the piece feels alive.

## Run it

Static site, no build step:

```bash
# Python 3
python -m http.server 5173

# or Node
npx serve .
```

Then open <http://localhost:5173/>.

> A local server (rather than `file://`) is recommended so Web Crypto and the
> clipboard APIs are available.

## Project layout

```
index.html            App shell + markup
styles.css            M3 Earthy Forest design system
js/
  theme.js            Light/dark theme manager
  presets.js          Content formatters + AES-GCM encryption
  hex-renderer.js     Hexagon art engine (text → honeycomb SVG)
  export.js           SVG/PNG/PDF export + clipboard
  app.js              Controller / state / wiring
```

## Privacy

All generation, encryption, and rendering happen client-side. The passphrase for
encrypted notes never leaves your device.
