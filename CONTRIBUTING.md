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

All UI follows the **Aurex Labs Design System** — Material Design 3, "Earthy Forest" aesthetic. See the style guide for tokens, typography, motion, and component specs.

**Key tokens:**

| Token | Light | Dark |
|-------|-------|------|
| Primary | `#466E47` | `#ABD37A` |
| Surface | `#FAF9F0` | `#13140E` |
| On-Surface | `#1A1C17` | `#E3E2D3` |

Font: Roboto Flex + Material Symbols Rounded. Motion: spring easing only.

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

## Micro-Service Architecture

Each tool lives in its own directory prefixed with `.`:

```
.totp/
├── index.html      # The tool (single-file for client-side tools)
├── README.md       # What it does, how to run it
├── .env.example    # Required env vars (if backend exists)
└── requirements.txt # Python deps (if applicable)
```

When adding a new tool:

1. Create `.<toolname>/` directory
2. Follow the design system
3. Add it to the root `index.html` landing page
4. Update the root `README.md`
5. Add a `README.md` for the tool

---

## License

By contributing, you agree your contributions are licensed under the MIT License.

---

*Questions? Open an issue or reach the team at hello@aurexlabs.xyz.*
