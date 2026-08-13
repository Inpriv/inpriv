# cftcfg

> Cloudflare Tunnel (`cloudflared`) configuration manager — TUI, GUI, and CLI.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Aurex Labs](https://aurexlabs.xyz).

## What it does

cftcfg is a configuration manager for Cloudflare Tunnel (cloudflared). It provides three interfaces — an interactive TUI, a graphical interface (tkinter), and a non-interactive CLI — for managing tunnel configurations, routes, and Docker container mappings.

## Features

- **Three interfaces** — TUI (Textual/Rich), GUI (tkinter), CLI (for scripting)
- **Tunnel management** — create, edit, delete tunnel configurations
- **Docker integration** — inspect running containers and map them to tunnel routes
- **YAML config editing** — read/write cloudflared config files
- **Cross-platform** — Windows, Linux, macOS
- **Non-interactive mode** — full CLI for automation and scripting

## Setup

### Prerequisites

- Python 3.10+
- `cloudflared` installed and on PATH
- Optional: Docker (for container inspection features)

### Install dependencies

```bash
pip install pyyaml rich textual
```

### Run

```bash
# Interactive TUI (default)
python cftcfg.py

# Graphical interface
python cftcfg.py gui

# CLI mode (for scripting)
python cftcfg.py cli --help
```

## Architecture

The tool operates in three modes:

| Mode | Flag | Interface | Use case |
|------|------|-----------|----------|
| TUI | *(default)* | Textual/Rich terminal UI | Daily management |
| GUI | `gui` | tkinter window | Desktop users |
| CLI | `cli` | stdout/stderr | Scripts, CI/CD |

All modes share the same core logic for reading/writing cloudflared configs and inspecting Docker containers.

## Security

- ⚠️ Uses `subprocess` to call `cloudflared` and `docker` CLI commands — inputs are validated and commands are constructed from fixed argument arrays (no shell injection)
- ✅ No network access beyond what `cloudflared` and `docker` themselves require
- ✅ No telemetry

## Tech

- Python 3.10+
- `pyyaml` — YAML config parsing
- `rich` / `textual` — terminal UI
- `tkinter` — GUI (bundled with Python)
- `subprocess` — cloudflared/docker CLI interaction
