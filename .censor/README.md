# Censor — Screenshot Redactor

**censor.inpriv.xyz** — blur, pixelate or black out sensitive content on screenshots before sharing them. Faces, card numbers, IP addresses, API keys, tokens, passwords, emails.

## What it does

- **Manual Studio** — draw redaction boxes on the image; pick **Blur** (gaussian), **Pixelate** (mosaic) or **Black Out** (solid), with strength control. Live preview, region list, per-region delete.
- **Face auto-detect** — on-device face detection (BlazeFace via [@vladmandic/human](https://github.com/vladmandic/human), WebGL). One click redacts every face found.
- **Text auto-detect** — on-device OCR ([tesseract.js](https://tesseract.projectnaptha.com/)) reads the screenshot, then regexes flag card numbers, IPv4 addresses, emails, API keys/tokens, long secret strings, and `password: …`-style keyword values. Each match becomes a redaction region.
- **Batch auto-redact** — run both detectors over every loaded file and export all redacted PNGs hands-free.
- **Zero-knowledge** — everything runs in the browser. No uploads, no telemetry, no server. Export is a clean PNG (canvas re-encode, so EXIF/metadata never survives).

## Engineering notes

- Single self-contained `index.html` (Inpriv Labs M3 Earthy Forest design system).
- Detection engines load lazily from CDN on first use, then stay cached for the session.
- Redaction composites always sample from the *original* pixels, so overlapping regions never smear into each other.
- OCR words are grouped into visual lines before regex matching; matches map back to word bounding boxes for precise boxes.
- Clipboard paste (`Ctrl+V`) drops screenshots straight into the tool.
- File input uses `accept="image/*"` (any raster input; output is always PNG).

## Deployment

Workers-with-assets (`worker/` dir), custom domain `censor.inpriv.xyz`, behind the global admin kill-switch (`common/gate.js`, service id `censor`).

```bash
cd .censor
cp index.html worker/public/index.html
cd worker && npx wrangler deploy
```

© 2026 Inpriv Labs — MIT License.
