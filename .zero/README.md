# Zero

> Zero-knowledge Solana crypto wallet — client-side key management with BIP39 mnemonic recovery.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

> ⚠️ **Status: Work in Progress** — Not audited. Do not use with real funds yet.

## What it does

Zero is a privacy-first Solana wallet where all cryptographic operations — key generation, transaction signing, wallet encryption — happen client-side. Your private keys never leave your browser. The wallet uses BIP39 mnemonic seeds for recovery and Argon2id + AES-256-GCM for at-rest encryption of the wallet state.

## Features

- **BIP39 mnemonic generation** — 12/24-word recovery phrases
- **BIP44 key derivation** — Ed25519 keypairs derived from mnemonic
- **AES-256-GCM encryption** — wallet state encrypted at rest with Argon2id-derived key
- **Transaction signing** — sign Solana transactions client-side
- **Address derivation** — base58 public key addresses
- **RPC communication** — queries Solana RPC nodes for balance and transaction broadcasting
- **Import/export** — import from private key (base58) or mnemonic

## Architecture

| Layer | Technology | Where |
|-------|-----------|-------|
| Key generation | BIP39 → BIP44 → Ed25519 (Python: `solders`, JS: `@noble/curves`) | Client-side |
| Wallet encryption | AES-256-GCM + Argon2id | Client-side |
| Transaction signing | Ed25519 via `@solana/web3.js` | Client-side |
| Blockchain queries | Solana RPC (configurable endpoint) | RPC node (read/broadcast only) |

**The server never sees:** private keys, mnemonics, wallet passwords, decrypted state.

**The RPC node sees:** public addresses, signed transactions (standard Solana).

## Setup

### Prerequisites

- Python 3.10+ (for backend crypto utilities)
- Node.js 18+ (for frontend build)
- Solana RPC endpoint (mainnet, devnet, or custom)

### Install

```bash
cd .zero

# Python backend utils
pip install -r requirements.txt

# Frontend
npm install
npm run build
```

### Environment variables

Copy `.env.example` to `.env` and configure:

```bash
# Solana RPC endpoint
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Network: mainnet | devnet | testnet
SOLANA_NETWORK=mainnet
```

### Run

```bash
# Development
npm run dev

# Production build
npm run build
```

## Security

- ⚠️ **Not audited** — do not use with significant funds
- ✅ Keys generated client-side via Web Crypto API and `@noble/curves`
- ✅ Wallet encrypted at rest with Argon2id key derivation
- ✅ No keys transmitted over network — only signed transactions
- ✅ No telemetry or analytics
- 🔒 **TODO:** Professional security audit before mainnet release

## Tech

- **Frontend:** Vanilla JS + esbuild, `@solana/web3.js`, `@noble/curves`, `@scure/bip39`
- **Backend utils:** Python 3.10+, `solders`, `argon2-cffi`, `PyNaCl`
- **Design:** Material Design 3 (Aurex Labs Design System)
