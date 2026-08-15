# Inpriv Stego 🕵️

> Hide encrypted messages inside PNG images — in your browser, forever.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

Stego hides a secret message inside the pixels of a PNG image using **LSB
steganography** (least-significant-bit embedding). The resulting image looks
identical to the original — the data lives in the last bit of each color
channel, below the threshold of human perception.

Optionally, the message is **encrypted with AES-256-GCM** (key derived from
your password via PBKDF2, 100k iterations) *before* embedding. Without the
password, nobody can even tell there is a message — let alone read it.

Everything happens client-side. **No uploads, no servers, no telemetry** —
the image never leaves your device.

## Features

- **LSB embedding across R, G, B** of fully-opaque pixels
- **Optional AES-256-GCM encryption** — PBKDF2-SHA-256 (100k iterations), random 16-byte salt + 12-byte IV per message
- **Magic header** `IVS1` + length — instant detection of valid payloads and graceful "no message found" UX
- **Alpha-safe embedding** — semi-transparent pixels are skipped (canvas alpha premultiplication would corrupt them)
- **Metadata stripped** — output is re-encoded from raw pixels; original EXIF/GPS never survives
- **Live capacity meter** — shows how much hidden data the image can carry before you hit Hide
- **Overwrite warning** — detects an existing payload before you hide over it
- **Zero network** — CSP-locked, `connect-src 'self'`, works offline after first load

## Format

Embedded byte stream (hidden LSB-first across color channels):

```
┌──────────────┬────────┬───────────────────┬──────────────────────────┐
│ "IVS1" (4B)  │ flag   │ payload length    │ payload (N bytes)        │
│ magic        │ 1 B    │ uint32 BE (4 B)   │ flag 0: UTF-8 plaintext  │
│              │        │                   │ flag 1: salt‖iv‖ct (AES) │
└──────────────┴────────┴───────────────────┴──────────────────────────┘
```

Encryption payload layout (flag 1): `salt (16B) ‖ IV (12B) ‖ AES-256-GCM ciphertext`.
The GCM tag is part of the ciphertext — tampering or a wrong password makes
decryption fail cleanly.

**Capacity:** `opaque_pixels × 3 bits − 72 bits (header)`. A 1920×1080 PNG
holds ~778 KB of hidden data.

## Using it

1. **Hide** — pick a PNG, type your message, optionally set a password, hit *Hide message*. The stego PNG downloads as `<name>-stego.png`.
2. **Share the file as a file.** Messengers and social media re-encode images (JPEG, resizing) — that destroys the hidden bits. Send via Hush, email attachment, or any file transfer.
3. **Reveal** — open stego.inpriv.xyz, drop the PNG, enter the password if it was encrypted, hit *Reveal message*.

## Security notes

- LSB steganography is **not** undetectable to statistical analysis — it hides
  messages from humans and casual inspection, not from a determined
  steganalyst. The AES-256-GCM layer is what actually protects the *content*.
- The password never leaves the browser; derivation and decryption are 100% local (WebCrypto).
- Re-saving the stego PNG through any lossy pipeline (JPEG conversion,
  resize, screenshot, most messengers' "compression") destroys the payload.
- PNG output is re-encoded from raw pixel data — all original metadata
  (EXIF, GPS, software tags) is stripped by design.

## Limitations

- PNG input only (the whole point — lossless).
- Images up to 40 MP (browser canvas sanity cap).
- No steganographic "cover story" — a suspicious adversary can run
  steganalysis tools; the encryption layer denies them the plaintext.

## Tech

- Vanilla HTML/CSS/JS, single-file tool (no build step)
- Web Crypto API (AES-GCM, PBKDF2), Canvas API
- Material Design 3, Earthy Forest (Aurex Labs Design System)
