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
| **Inpriv ID** | username, recovery email, sign-in records | your password (only a salted hash is stored) |

### Cryptography

| Purpose | Algorithm |
|---|---|
| Mailbox key pair | RSA-OAEP 2048, SHA-256 |
| Message encryption | AES-256-GCM, a fresh key per message |
| Private-key protection | AES-256-GCM with a key from PBKDF2-SHA-256 (300,000 iterations) of your password |
| Password storage | chained PBKDF2-SHA-256 (300,000 iterations), 16-byte random salt |
| Two-factor | TOTP (RFC 6238), secret sealed with AES-256-GCM at rest |
| Sessions | random 32-byte tokens, stored as SHA-256 hashes |
| Randomness | `crypto.getRandomValues()` / Web Crypto |

Your private key and the password-derived key never leave your browser. "Skip master password" stores the mailbox key wrapped with a key that exists only on that device.

## Dependencies

The pages and Workers use no frameworks and load no third-party scripts at runtime. The only build tool is `wrangler` (pinned in the deploy workflow).
