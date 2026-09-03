# Inpriv Mail

> Mobile-first, zero-knowledge encrypted email with hybrid RSA-2048 + AES-GCM encryption, fully integrated with Inpriv ID.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Inpriv Mail is a mobile-first, end-to-end encrypted email service. Users register an
`@inpriv.xyz` address (or sign in using their unified **Inpriv ID**). RSA-OAEP-2048 keypairs
are generated directly in the browser; private keys are sealed with AES-GCM derived from
the user's master password via PBKDF2-SHA256 (300,000 iterations).

The server stores only ciphertext envelopes and can never decrypt messages.

## Encryption scope — what is and isn't E2EE

**End-to-end encrypted (nobody but the participants can read these):**

- **Internal mail** — `@inpriv.xyz` → `@inpriv.xyz`. The body is encrypted in the
  sender's browser to the recipient's public key (hybrid RSA-2048-OAEP + AES-256-GCM)
  and stays ciphertext until the recipient opens it. The server never holds the key.

**Encrypted at rest, but not end-to-end (the server sees the content briefly):**

- **Inbound external mail** (from Gmail, Outlook, etc.) — the sender cannot know the
  recipient's key, so the message arrives over TLS in plain text. The Worker encrypts
  it to the recipient's public key (`serverHybridEncrypt`) *before* writing it to the
  database. This is gateway encryption — the same model Proton Mail uses for inbound
  external mail. It is a fundamental limit of email, not a missing feature.
- **Outbound external mail** — relayed through Resend in plain text (with TLS in
  transit). A recipient outside the suite cannot decrypt anything.

**Never encrypted (metadata):**

- Subject lines, sender/recipient addresses, timestamps and read flags are stored as
  plain columns in the database, for all mail — internal included. Only message bodies
  are end-to-end encrypted.

**Attachments:** external inbound attachments are listed as metadata only (names,
sizes, types); contents are not stored or encrypted yet. Internal mail does not
support attachments.

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
