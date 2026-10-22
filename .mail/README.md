# Inpriv Mail

> Mobile-first email, end-to-end encrypted between Inpriv users (RSA-2048 + AES-GCM), with Inpriv ID accounts.

Part of [Inpriv](https://inpriv.xyz) by [Inpriv Labs](https://inpriv.xyz).

## What it does

Inpriv Mail is a mobile-first email service. People sign in with their **Inpriv ID**
password; RSA-OAEP-2048 key pairs are generated in the browser, and the mailbox's private
keys (the key ring) are sealed with AES-256-GCM under a key derived from a separate
**mailbox passphrase** (PBKDF2-SHA-256, 600,000 iterations) that never leaves the browser.

The server stores public keys, the sealed key ring and message envelopes. It can't open
stored bodies, as long as the page code it serves isn't modified (see SECURITY.md).

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
- **Passphrase-sealed key ring:** private keys never leave the browser unencrypted; the server stores only the sealed ring, and every change to it needs a proof made with the current key.
- **Dual-Envelope E2EE:** Both sender and recipient receive individually encrypted AES keys so senders can view and decrypt their sent mail history.
- **Remote content blocked:** HTML mail is sanitized and shown in a script-less sandboxed frame; images load only after "Load images".
- **Live Search & Suggestions:** Instant filtering of messages; recipient suggestions come only from your own correspondence (there is no user directory).

## Deploy

```bash
cd .mail/worker
cp ../index.html public/index.html
# then commit both; the Deploy Workers workflow deploys main
```
