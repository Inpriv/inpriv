# Inpriv Check

> Paste code, upload a file or point at a GitHub repository — scan it for malware, trojans, backdoors, exfiltration and obfuscation.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Check runs **static heuristic analysis** on source code and files, looking for the patterns real malware uses: reverse shells, PowerShell encoded payloads, download-and-execute cradles, credential theft, persistence mechanisms, defense evasion, ransomware loops, crypto miners, and obfuscation. It can also cross-check file hashes (and upload unknown files) against **VirusTotal's** 70+ antivirus engines.

## Engines

| Engine | Status | What it does |
|---|---|---|
| **Heuristic** | Live | ~60 built-in rules + combo detectors, zero external calls. Works on paste, file upload and GitHub repos. Fast, private, free. |
| **VirusTotal** | Live | SHA-256 lookup (instant when VT already knows the hash) or file upload → 70+ engine report. Requires the worker secret `VT_API_KEY`; free-tier rate limits apply. |
| **AI review** | Soon | An LLM reads the code and writes a plain-language security review. The engine and UI are prepared and armed — once the `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` secrets are set and the worker redeployed, the AI card goes live. |

## Inputs

- **Paste** — any script: JavaScript, Python, PowerShell, shell, batch, VBA, PHP, Ruby, Perl…
- **File** — up to 60 MB (Cloudflare free-plan body cap; VirusTotal itself accepts 650 MB); text files are scanned directly, binaries get hashed / uploaded to VirusTotal
- **GitHub repo** — a public `owner/repo` (or full URL). The worker walks the tree via the GitHub REST API and scans up to ~60 text files (1.5 MB each), skipping `node_modules`, build dirs and lockfiles.

## API

All endpoints are POST/GET JSON under `check.inpriv.xyz`:

- `POST /api/scan` — body `{ engines: ["static"|"vt"|"ai"], mode: "paste"|"file"|"github", … }`
- `GET /api/status` — engine availability + limits
- `GET /api/vt/poll?id=<analysis_id>` — poll a submitted VirusTotal analysis
- `GET /api/vt/lookup?hash=<sha256>` — direct VirusTotal hash lookup
- `GET /api/ai/status` — AI engine readiness
- `GET /api/health` — health + engine flags

Nothing is stored: no logs, no results database, no cookies. Rate limit is 10 scans/min/IP (in-memory).

## Run locally

```bash
python -m http.server 8080
# Open http://localhost:8080/.check/index.html (worker endpoints needed for scans)
```

## Security

- ✅ Code is transmitted to the edge for analysis, then discarded — nothing persisted
- ✅ All rendered output is escaped (`esc()` before `innerHTML`)
- ✅ Rate limited per IP
- ✅ Heuristic engine is dependency-free and runs on the worker (no D1/KV storage)
- ⚠️ Heuristic scan flags *patterns*, not certainties — a "clean" verdict does not guarantee a file is safe; malware is often polymorphic
- ℹ️ VirusTotal mode submits file hashes/uploads to VirusTotal by design
- ℹ️ External dependencies: Google Fonts (Google Sans Text, Material Symbols Rounded), local favicon

## Tech

- Vanilla HTML/CSS/JS (single-file frontend), no build step
- Cloudflare Workers module worker (ESM) with Workers-assets
- GitHub REST API for repo walking (`api.github.com`, optional `GITHUB_TOKEN` secret for rate limits)
- VirusTotal v3 API (`www.virustotal.com/api/v3`)
- OpenAI-compatible chat completions (prepared, not enabled)
- Material Design 3 (Google M3 baseline, dark default, `inpriv_theme`)