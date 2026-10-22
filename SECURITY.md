# Security Policy

## Reporting a vulnerability

**Please don't open a public GitHub issue for security problems.**

Email **security@inpriv.xyz** with:

- what you found and where (service, endpoint or file),
- steps to reproduce,
- the impact you expect,
- a suggested fix, if you have one.

If your report contains something sensitive, say so in the first message and we'll agree on how to exchange it.

| Stage | Target |
|---|---|
| Acknowledgement | within 72 hours |
| First assessment | within 7 days |
| Fix or mitigation | depends on severity; critical issues first |
| Public disclosure | after the fix ships, coordinated with you |

We don't run a paid bug bounty. We're happy to credit you in the fix's release notes unless you'd rather stay anonymous.

### Safe harbour

We won't take action against research that:

- only uses accounts you own or test accounts you created,
- doesn't read, change or delete other people's data,
- doesn't degrade the service for others (no load testing, spam or social engineering of users or staff),
- gives us reasonable time to fix the problem before you publish.

## Scope

In scope: `inpriv.xyz`, `mail.inpriv.xyz`, `temp.inpriv.xyz`, `id.inpriv.xyz`, `admin.inpriv.xyz` and the code in this repository.

Out of scope: third-party services we rely on (Cloudflare, Resend), missing security headers without a demonstrated impact, self-XSS, and reports from automated scanners without a working proof of concept.

## How Inpriv is built

All services run as Cloudflare Workers with Cloudflare D1 databases. The full description of what is stored, and what isn't, is in the [Privacy Policy](https://inpriv.xyz/privacy).

| Service | What the server can read | What it can't read |
|---|---|---|
| **Mail**, Inpriv → Inpriv | sender, recipient, subject, time, size | the message body (encrypted in the sender's browser) |
| **Mail**, from outside | the message while it's received; it's then stored encrypted to your key | the stored body afterwards |
| **Mail**, to outside | the message while it's handed to the mail relay | — (regular email is not end-to-end encrypted) |
| **Temp** | everything in the inbox (not end-to-end encrypted, deleted after 24 h) | — |
| **Inpriv ID** | username, recovery email, sign-in records; the password while it's checked at sign-in | the stored password (only a salted hash), the mailbox passphrase |

### Cryptography

| Purpose | Algorithm |
|---|---|
| Mailbox key pair | RSA-OAEP 2048, SHA-256; key id = first 128 bits of SHA-256 over the public key (SPKI) |
| Message encryption | AES-256-GCM, a fresh key per message, wrapped with RSA-OAEP to the recipient and to the sender |
| Key ring protection (format 2) | AES-256-GCM (AAD `inpriv-mail-keyring-v2`) with a key from PBKDF2-SHA-256 (600,000 iterations, 16-byte salt) of the **mailbox passphrase**, which never leaves the browser |
| Key ring changes | proof of possession: the server encrypts a random value to the current public key; the browser must return it |
| Password storage | chained PBKDF2-SHA-256 (300,000 iterations), 16-byte random salt |
| Two-factor | TOTP (RFC 6238), secret sealed with AES-256-GCM at rest |
| Sessions | random 32-byte tokens in HttpOnly, Secure, SameSite=Strict cookies, stored as SHA-256 hashes |
| Randomness | `crypto.getRandomValues()` / Web Crypto |

Format 1 (mailboxes created before 22 October 2026) sealed the private key with a key derived from the Inpriv ID password, which the server receives at sign-in. Such a mailbox is upgraded the next time it's opened: the old key moves into a passphrase-sealed key ring and a new key pair is used for new mail. The upgrade can't undo the earlier exposure of the old key.

### Threat model, in short

- **Protected:** stored message bodies and private keys against someone who reads the databases or backups (as strong as the mailbox passphrase, which they can try to guess offline), an operator who only reads stored data, and a passive network observer.
- **Not protected:** a server or deployment that serves modified page code (it could capture the passphrase), a compromised browser or device, metadata (who, when, subject), and mail to or from other providers while it passes through. Public keys come from the server; Mail shows key ids and warns when a known recipient's key changes, but nothing checks keys automatically.
- **Email content** is shown in a sandboxed frame without scripts, after a parser-based sanitizer, with remote images blocked until the reader asks.
- **Skip mailbox passphrase** keeps a device key in the browser's storage. Anyone with that browser profile, or any script running on mail.inpriv.xyz, can open the mailbox with it.

## Testing

`tests/` runs every Worker locally (`tests/local.sh up`) and checks the security properties above: `node --test tests/api.test.mjs`, and in headless Firefox `node --test tests/browser.test.mjs` (after `cd tests && npm install`). See [tests/README.md](tests/README.md).

## Dependencies

The pages and Workers use no frameworks and load no third-party scripts at runtime. The only build tool is `wrangler` (pinned in the deploy workflow). The tests use `puppeteer-core` and a local Firefox.
