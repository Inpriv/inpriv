# Inpriv Pay — Non-Custodial Crypto Payment Gateway

> A non-custodial cryptocurrency payment gateway for Bitcoin, Monero, and Solana. Zero private key exposure. Fully client-side.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Pay lets you create and receive cryptocurrency payment requests for BTC, XMR, and SOL without any custodian or server-side key handling. Payment requests are encoded entirely in shareable URL fragments (`#data=...`) as base64url-encoded JSON. The payer opens the link, sees a QR code and wallet URI, and can pay via detected browser wallet extensions (Phantom, Solflare, WebLN) or their native wallet app. All signing and address derivation happen client-side — no private keys ever touch a server.

## Features

- **Three networks** — Solana (SOL), Bitcoin (BTC), Monero (XMR)
- **URL-driven checkout** — payment requests live entirely in shareable URL fragments (no server logs)
- **Address validation** — regex + charset validation per coin; rejects WIF/hex private keys with explicit warnings
- **QR code generation** — built-in QR encoder (Reed-Solomon error correction, no external QR library)
- **Wallet detection** — detects Phantom, Solflare, and WebLN browser extensions
- **Live on-chain monitoring** — Solana (WebSocket `accountSubscribe` + HTTP polling fallback), Bitcoin (mempool.space API), Monero (address display)
- **Fiat reference** — optional USD/EUR amount toggle
- **Optional metadata** — title, description, and XMR secret view key (read-only tracking)
- **QR codes** rendered theme-aware (dark/light) on `<canvas>`

## How it works

The request flow: a recipient enters their public address + amount → the tool validates the address format, builds a JSON payload, base64url-encodes it, and appends it as a URL fragment (`#data=`). Opening such a URL decodes the fragment client-side and renders a payment view with a wallet URI (`solana:`, `bitcoin:`, `monero:`) and QR code. For monitoring, Solana uses a WebSocket subscription to `accountSubscribe` (falling back to `getBalance` polling every 8s), Bitcoin polls `mempool.space` for tx count changes every 12s. The QR encoder is a complete from-scratch implementation (GF(256) Reed-Solomon, finder/timing/alignment patterns, masking, format info).

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.pay/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — no private keys are ever requested or handled
- ✅ Address validation explicitly rejects private key formats (WIF, hex) with warnings
- ✅ User input sanitized via `sanitizeHTML()` before DOM insertion
- ✅ No `eval()` or hardcoded secrets
- ✅ Payment data stays in URL fragment (not sent to any server)
- ⚠️ Makes external calls to Solana RPC (`api.mainnet-beta.solana.com`), `mempool.space` for payment monitoring — these are public blockchain APIs
- ⚠️ `<base target="_blank">` on the page opens all links in new tabs (note for security reviewers)
- ⚠️ External font dependencies (Google Fonts)
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Inpriv Labs Design System)
- Custom QR code encoder (Reed-Solomon / GF(256), no external QR library)
- WebSocket + fetch for on-chain payment monitoring
- Roboto Flex + Material Symbols Rounded (Google Fonts)
