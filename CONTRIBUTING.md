# Contributing to Inpriv

Thanks for helping. Inpriv is small on purpose, and every change is held to the same rules.

## Principles (non-negotiable)

1. **Nothing phones home.** No analytics, telemetry, trackers, third-party fonts, CDNs or remote scripts. Everything a page needs is inlined or served by its own Worker.
2. **Encryption happens in the browser.** Private keys and password-derived keys never reach a server. Don't add a code path that could.
3. **Say what is stored.** If a change stores or logs anything new about users, update the [Privacy Policy](worker/public/privacy.html) in the same pull request.
4. **No features that enable abuse:** no bulk sending, no hiding the sender of outgoing mail, nothing that helps someone get into accounts that aren't theirs.

## Layout

```
inpriv/
├── index.html            landing page source → copied to worker/public/index.html
├── worker/               Worker "inpriv": inpriv.xyz, legal pages, sitemap, robots
├── .mail/                Inpriv Mail: page (index.html) + Worker (worker/)
├── .temp/                Inpriv Temp: page + Worker
├── .id/                  Inpriv ID: Worker; its page is worker/public/
├── .admin/               admin.inpriv.xyz: kill-switches, team mailboxes, records
├── .status/              status.inpriv.xyz: uptime checks + page
└── common/               shared by every Worker: gate, error pages, UI core
```

Folders starting with a dot are ordinary project folders.

## Design

Every page inlines the shared UI core from `common/ui/` (`inpriv-ui.css`, `inpriv-ui.js`): ink-and-paper colours with one warm accent, glass panels, system fonts, inline SVG icons and spring motion. Use the tokens (`--bg`, `--text`, `--text-2`, `--text-3`, `--fill*`, `--well`, `--hairline`, `--accent`, `--danger`). Dark is the default; light follows the system.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0c0c0b` | `#ebe9e4` |
| `--text` | `#f2f1ed` | `#141412` |
| `--accent` | `#ff6a2b` | `#e4511b` |

Use the accent for one thing per screen at most. Respect `prefers-reduced-motion`, keep focus visible, and keep inputs at 16px so iOS doesn't zoom.

Edit the **source** page (`index.html`, `.mail/index.html`, `.temp/index.html`), never the served copy. `node common/ui/sync.mjs` refreshes the UI core in every page and copies each source page to the folder its Worker serves; commit the files it writes.

## Running locally

```bash
cd .mail/worker
npx wrangler d1 execute inpriv-mail --local --file ../schema.sql
npx wrangler d1 execute inpriv-id   --local --file ../../.id/schema.sql
npx wrangler dev
```

Put local-only secrets in `.dev.vars` (gitignored), for example `ID_ENC_KEY=<32 random characters>`. Never use production data or keys for local testing.

## Pull requests

1. For anything bigger than a small fix, open an issue first so we can agree on the approach.
2. Branch from `main`, keep the change focused, and match the style around it: vanilla HTML/CSS/JS, no frameworks, no build step.
3. Test it: `node --check` your Worker, run it with `wrangler dev`, and for login, 2FA, password or key changes describe what you tested before and after.
4. Fill in the pull request template.

Merging to `main` deploys the changed Workers automatically (`.github/workflows/deploy-workers.yml`).

### Checklist

- [ ] No secrets, keys or personal data in the diff
- [ ] No new third-party requests
- [ ] No `eval()`, and no `innerHTML` with unescaped user input
- [ ] Privacy Policy updated if anything new is stored or logged
- [ ] Tested locally

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

Questions: open an issue, or write to support@inpriv.xyz. Security problems go to security@inpriv.xyz — see [SECURITY.md](SECURITY.md).
