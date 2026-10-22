<div align="center">

<img src="icon.png" width="72" height="72" alt="Inpriv logo">

# Inpriv

### Private email. One address to keep, one to throw away.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-inpriv.xyz-0c0c0b)](https://inpriv.xyz)

[Website](https://inpriv.xyz) · [Terms](https://inpriv.xyz/terms) · [Privacy](https://inpriv.xyz/privacy) · [License](LICENSE) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What it is

Inpriv is two ways to receive email on an @inpriv.xyz address, plus the account behind them:

- **Mail** — [mail.inpriv.xyz](https://mail.inpriv.xyz) — a permanent mailbox. Mail between Inpriv users is end-to-end encrypted in your browser (RSA-2048 + AES-256-GCM), and your keys are locked with a mailbox passphrase that never leaves your device. Mail to and from Gmail, Outlook and others is normal email through a relay, stored encrypted to your key. Remote images in received mail are blocked until you load them.
- **Temp** — [temp.inpriv.xyz](https://temp.inpriv.xyz) — a random disposable address with a live inbox. No sign-up. It deletes itself after 24 hours, or when you say so, and its address is never given to anyone else. Temp inboxes are not end-to-end encrypted.
- **Inpriv ID** — [id.inpriv.xyz](https://id.inpriv.xyz) — your account: the @inpriv.xyz address, password, optional 2FA, sessions.

[status.inpriv.xyz](https://status.inpriv.xyz) shows whether each site is up, checked every 5 minutes, with 90 days of history.

[inpriv.xyz](https://inpriv.xyz) lets you choose between Mail and Temp. If you're signed in with Inpriv ID it takes you straight to Mail; `inpriv.xyz/?home` always shows the choice.

No ads, no analytics, no trackers. Inpriv keeps a limited access log (network, browser family, time) for 30 days for account security and abuse handling; the [Privacy Policy](https://inpriv.xyz/privacy) lists everything that is stored.

---

## Layout

```
inpriv/
├── index.html            landing page source (copied to worker/public/)
├── worker/               Worker "inpriv": inpriv.xyz, legal pages, sitemap, robots
├── .mail/                Inpriv Mail: page (index.html) + Worker (worker/)
├── .temp/                Inpriv Temp: page + Worker (D1, inbound webhook, hourly cleanup, 5-minute status tick)
├── .id/                  Inpriv ID: Worker + page (worker/public/)
├── .admin/               admin.inpriv.xyz: kill-switches, team mailboxes, records
├── .status/              status.inpriv.xyz: uptime checks + page (worker/public/)
└── common/
│   ├── ui/               shared design core: inpriv-ui.css, inpriv-ui.js, sync.mjs
│   ├── page.js           styles for Worker-rendered pages
│   ├── errors.js         404/410/429/500 pages
│   ├── access-log.js     access log, 30 days, networks not full IPs (see the Privacy Policy)
│   ├── addresses.js      who owns each @inpriv.xyz address; claims are never released
│   ├── security.js       security headers, hash-based CSP, same-origin checks
│   ├── email-html.js     strips active content from received HTML (HTMLRewriter)
│   └── gate.js           maintenance gate
```

## Design

Every page uses one shared core in `common/ui/`: ink-and-paper colours with one warm accent, liquid glass over faint drifting text, system fonts, inline SVG icons and spring motion. Dark by default, light follows the system, and the theme button stores an explicit choice.

The core is inlined into each page, so pages make no extra requests. After editing `common/ui/inpriv-ui.css` or `inpriv-ui.js`, or any page source, run:

```bash
node common/ui/sync.mjs
```

It refreshes the core in every page and copies each source page into the folder its Worker serves. `--check` exits non-zero when something is out of date.

## Running locally

Serve a page's `worker/public` folder with any static server, for example:

```bash
python -m http.server 8080 -d .temp/worker/public
```

The pages call their own `/api/…` routes, so a static server shows the interface only. To exercise the API, deploy a preview Worker (see CONTRIBUTING.md).

---

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)**. Nothing may phone home: no analytics, no third-party requests.

Found a security issue? See **[SECURITY.md](SECURITY.md)**.

## License

MIT © 2026 [Inpriv Labs](https://inpriv.xyz)
