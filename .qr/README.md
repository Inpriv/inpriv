# Inpriv QR — Generate & Read QR Codes

> Generate QR codes from text, URLs, WiFi or contacts, or read QR codes from your camera or an image — all in your browser. Zero-knowledge, fully client-side.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

QR is a dual-mode tool: it generates QR codes from text, URLs, WiFi credentials, contact cards (vCard), or email messages, and it decodes QR codes from camera input or uploaded images. Generation supports custom error correction levels, adjustable scale, and logo overlays. All encoding and decoding happens locally — nothing is transmitted or uploaded.

## Features

- **Generate modes** — plain text, URL, WiFi (WPA/WEP/none), contact (vCard), email (mailto)
- **Read modes** — live camera scanning + image file upload/drag-drop decoding
- **Error correction** — selectable L/M/Q/H levels (auto-bumps to H when a logo is added)
- **Adjustable scale** — multiple output resolutions
- **Logo overlay** — add a centered logo image with size control (Small/Medium/Large)
- **High-res PNG export** — downloads at ≥10px cell size regardless of preview scale
- **Copy content** — copy the encoded payload to clipboard
- **Camera switching** — toggle between front (user) and rear (environment) cameras
- **URL detection** — decoded URLs get a clickable "Open link" action
- **Dark/light theme** toggle with system preference detection

## How it works

**Generation:** A bundled QR encoder (adapted, MIT-licensed) builds the QR matrix in JavaScript — it constructs finder/timing/alignment patterns, encodes the payload as bytes with Reed-Solomon error correction over GF(256), applies masking, and renders to a `<canvas>`. Logo overlays are composited onto the canvas via `drawImage()` after the QR is drawn.

**Reading:** Image decoding uses [jsQR](https://github.com/cozmo/jsQR) (loaded from CDN, MIT-licensed). For camera scanning, `navigator.mediaDevices.getUserMedia()` captures video, and every 300ms a frame is drawn to an offscreen canvas; `getImageData()` feeds the pixel buffer to jsQR with `inversionAttempts: "attemptBoth"` for robustness.

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.qr/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — nothing is transmitted or uploaded
- ✅ No `eval()`, no hardcoded secrets
- ✅ Camera stream is stopped on page unload (`beforeunload` handler)
- ⚠️ Depends on external CDN: `jsqr@1.4.0` from jsdelivr (SRI hash not present — consider adding `integrity=""`)
- ⚠️ External favicon referenced from `hush.best`
- ⚠️ External font dependencies (Google Fonts)
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)
- ⚠️ Camera requires HTTPS or localhost (browser security requirement)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Inpriv Labs Design System)
- Bundled QR encoder (Reed-Solomon / GF(256), adapted MIT)
- jsQR decoder (CDN, MIT) for image/camera decoding
- Canvas API for rendering and frame capture
- `getUserMedia()` for camera access
- Roboto Flex + Material Symbols Rounded (Google Fonts)
