# Inpriv Mail

> Mobile-first, zero-knowledge encrypted email with hybrid RSA-2048 + AES-GCM encryption, fully integrated with Inpriv ID.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Inpriv Mail is a mobile-first, end-to-end encrypted email service. Users register an
`@inpriv.xyz` address (or sign in using their unified **Inpriv ID**). RSA-OAEP-2048 keypairs
are generated directly in the browser; private keys are sealed with AES-GCM derived from
the user's master password via PBKDF2-SHA256 (300,000 iterations).

The server stores only ciphertext envelopes and can never decrypt messages.

## Key Features

- **Inpriv ID Synchronization:** Seamless single sign-on integration with `id.inpriv.xyz`. Accounts share identity and `@inpriv.xyz` mailboxes across the suite.
- **Mobile-First UX:** Designed for thumb ergonomics with mobile bottom navigation (Inbox, Sent, Compose, Account), slide-over message reader, and full-screen compose sheet with touch targets ≥44px and safe-area support.
- **Zero-Knowledge Architecture:** RSA private keys never leave the browser unencrypted; the server stores only AES-GCM-wrapped PKCS#8 blobs.
- **Dual-Envelope E2EE:** Both sender and recipient receive individually encrypted AES keys so senders can view and decrypt their sent mail history.
- **M3 Earthy Forest Aesthetics:** Dark/light themes, Roboto Flex, crisp Material Symbols Rounded vector icons, glassmorphism app bars.
- **Live Search & Autocomplete:** Instant filtering of messages and autocomplete for `@inpriv.xyz` user handles.

## Deploy

```bash
cd .mail/worker
cp ../index.html public/index.html
npx wrangler deploy
```
