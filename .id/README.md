# Inpriv ID — Central Account System

One private account for every Inpriv service. Google-style One Tap sign-in,
TOTP 2FA, encrypted personalization vault, session management.

## Architecture

- **Worker**: `inpriv-id` on `id.inpriv.xyz`
- **D1**: `inpriv-id` (users, sessions, TOTP secrets, recovery codes, vault, auth events)
- **One Tap widget**: `https://id.inpriv.xyz/id.js` — drop-in script for every service

## Security model

| Layer | Protection |
|---|---|
| Passwords | PBKDF2-SHA256, 310 000 iterations, per-user 16-byte salt |
| Sessions | Opaque 32-byte tokens, sha256 at rest, rotating on each use, 30-day TTL |
| 2FA | TOTP RFC 6238 (SHA-1, 6 digits, ±1 step), secret AES-256-GCM encrypted at rest |
| Recovery | 10 single-use codes, sha256 at rest, shown once |
| Vault | Profile blob AES-256-GCM sealed server-side before D1 |
| Transport | TLS + Secure cookies (HttpOnly, SameSite=None, Partitioned) |
| Rate limits | login 10/15min/IP · register 5/h/IP · verify 5/h · 2FA setup 5/h |
| Enumeration | Constant-time compares + dummy-hash on unknown email |
| Kill switch | `account` service id in admin.inpriv.xyz panel |

## API

```
POST /api/register          {email, password, nick?}         → {token, user}
POST /api/login             {email, password}                → {token,user} | {mfa_required, mfa_token}
POST /api/login/2fa         {mfa_token, code | recovery}     → {token, user}
GET  /api/me                Bearer — rotates token
GET  /api/public/me         cookie — One Tap check (CORS *.inpriv.xyz, credentials)
GET/POST /api/vault/get|set encrypted profile blob
POST /api/verify/send|confirm
POST /api/2fa/setup|confirm|disable
GET  /api/sessions · POST /api/sessions/revoke|revoke-all
GET  /api/events
POST /api/profile /password/change /account/delete
```

## One Tap widget usage (any service)

```html
<!-- basic: avatar chip when signed in -->
<script src="https://id.inpriv.xyz/id.js" defer></script>

<!-- account-supporting service: adds Continue-as prompt + sign-in card -->
<script src="https://id.inpriv.xyz/id.js" data-service="mail" data-accounts defer></script>
```

The page receives `inpriv:id` (user object) and `inpriv:connect` events,
plus `window.InprivID` API (`user`, `check()`, `connect()`, `open()`).

## Deploy

```bash
cd .id/worker
npx wrangler d1 create inpriv-id          # paste id into wrangler.toml
npx wrangler d1 execute inpriv-id --remote --file=../schema.sql
npx wrangler secret put ID_ENC_KEY        # openssl rand -base64 32
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

## Email

Verification mails from `Inpriv <noreply@inpriv.xyz>` via Resend.
DNS: SPF include resend.com + DKIM in Cloudflare dashboard (Resend domains).

## Quick Sign-In (SSO) + Quick Unlock

One account, every service — Google-style:
- **Quick Sign-In**: a signed-in browser (cookie on id.inpriv.xyz) can mint a
  single-use 120-second grant (POST /api/grant from id.js); the target service
  backend redeems it server-to-server (POST /api/grant/redeem, X-Inpriv-Service:
  SERVICE_KEY) and issues its own session. For 2FA accounts Mail still asks for
  the code (/api/v1/sso/verify): the grant alone never opens Mail. The mailbox
  stays locked until the mailbox passphrase (or this device's Quick Unlock key)
  opens it in the browser.
- **Quick Unlock / "Skip mailbox passphrase"** (on by default, off-able here
  and in Mail): after one passphrase unlock, Mail stores the passphrase key
  wrapped under a random device key kept in the browser's storage (Mail's
  device_keys table, one row per device; enrolling needs a proof made with the
  mailbox key). Anyone with that browser profile can open the mailbox.
  Turning it off removes every device's wrap; single devices can be forgotten
  in Mail.
- **Session cookie**: HttpOnly, Secure, SameSite=Strict. Tokens are never
  returned in response bodies. State-changing requests must come from one of
  the Inpriv origins (exact list in lib.js). Changing the password or 2FA, or
  signing out everywhere, also ends Mail sessions.
