# Contributing to Inpriv

First off — thank you for considering a contribution. Inpriv is built with care, and we hold every contribution to the same standard.

---

## Design Principles (Non-Negotiable)

These principles define what Inpriv IS. Violating them means the PR will be rejected.

1. **Zero-knowledge by design** — nothing may ever phone home. No analytics, no telemetry, no remote logging. If your change sends user data to a server, it doesn't belong here.
2. **Client-side first** — all processing happens in the browser. Server components exist only for encrypted relay (Hush), ephemeral encrypted storage (Burn), or query routing (OSINT).
3. **No malicious features** — modules that enable unauthorized access, surveillance, or harm to users will be rejected.
4. **Privacy is not optional** — privacy features cannot be "opt-in." They are the default and the only option.

---

## Design System

Every page uses the shared core in [`common/ui/`](common/ui/): ink-and-paper colours with one warm accent, liquid glass over faint drifting text, system fonts, inline SVG icons and spring motion. Components use tokens only (`--bg`, `--text`, `--text-2`, `--text-3`, `--fill*`, `--well`, `--hairline`, `--accent`, `--danger`); dark is the default and light follows the system.

| Token | Dark | Light |
|-------|------|-------|
| `--bg` | `#0c0c0b` | `#ebe9e4` |
| `--text` | `#f2f1ed` | `#141412` |
| `--accent` | `#ff6a2b` | `#e4511b` |

Use the accent for one thing per screen at most. Respect `prefers-reduced-motion`, keep focus visible, and keep inputs at 16px so iOS doesn't zoom.

After changing the core or a page source, run `node common/ui/sync.mjs`.

---

## How to Contribute

### 1. Open an issue first

For anything beyond a typo fix, open an issue describing what you want to build/change. We'll discuss the approach before you write code.

### 2. Fork & branch

```bash
git clone https://github.com/salo-yek/inpriv.git
cd inpriv
git checkout -b feat/your-feature-name
```

### 3. Build & test locally

```bash
# Serve the suite locally
python -m http.server 8080

# Or run a specific micro-service backend
cd .hush && python server.py
```

### 4. Code style

- **HTML/CSS/JS** — vanilla, no build step required (except `.zero` which uses esbuild)
- **Python** — PEP 8, type hints where practical
- **Rust** — `cargo fmt`, `cargo clippy`
- **No inline event handlers** — use `addEventListener`
- **CSP-compliant** — no `eval()`, no inline scripts, no `unsafe-inline`

### 5. Commit format

```
<type>(<scope>): <description>

feat(totp): add QR code import
fix(hush): handle WebSocket reconnect on mobile
docs(readme): update live tools list
chore(gitignore): add .venv pattern
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `security`

### 6. Security checklist

Before opening a PR, verify:

- [ ] No secrets, API keys, or credentials in the diff
- [ ] No `console.log` with sensitive data
- [ ] No external CDN dependencies added
- [ ] No `eval()`, `innerHTML` with user input, or `document.write()`
- [ ] New dependencies are pinned and necessary
- [ ] `.env.example` updated if new env vars are needed

### 7. Submit

Open a PR against `main`. Include:

- Summary of changes
- Which micro-service(s) affected
- Security implications (if any)
- Screenshots (if UI changes)

---

## Layout

Each app lives in its own directory prefixed with `.`, with its page and its Cloudflare Worker:

```
.temp/
├── index.html          # page source
└── worker/
    ├── public/         # what the Worker serves (index.html is a synced copy)
    ├── src/index.js    # Worker entry
    └── wrangler.toml
```

Preview a Worker without touching production: copy `wrangler.toml`, remove the `routes` block (and `[triggers]`), set `workers_dev = true` in the copy, then `npx wrangler deploy -c <that file> --name inpriv-<app>-preview`. Production Workers answer only on their inpriv.xyz domains. Delete the preview when you're done, and don't paste its workers.dev address anywhere public.

---

## License

By contributing, you agree your contributions are licensed under the MIT License.

---

*Questions? Open an issue or reach the team at hello@inpriv.xyz.*
