import json
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel

load_dotenv()

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.json"

app = FastAPI(title="Inpriv Panel")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── EU country list (27 member states + EEA) ──────────────────────────
EU_COUNTRIES = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    # EEA / Schengen associates
    "IS", "LI", "NO", "CH",
}

# Simple in-memory GeoIP cache
_geoip_cache = {}  # ip -> {"country_code": str, "cached_at": float}
GEOIP_CACHE_TTL = 3600  # 1 hour

# ── Config helpers ────────────────────────────────────────────────────

def _load_config() -> dict:
    """Load config from JSON file, returning a fresh dict."""
    if not CONFIG_PATH.exists():
        return _default_config()
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return _default_config()


def _save_config(cfg: dict) -> None:
    """Atomically write config to disk."""
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    tmp.replace(CONFIG_PATH)


def _default_config() -> dict:
    return {
        "global": {
            "block_eu_ips": True,
            "blocked_title": "Access Restricted",
            "blocked_message": (
                "Due to the European Union's Chat Control 2.0 regulation "
                "\u2014 which mandates mass surveillance of private communications "
                "\u2014 Inpriv cannot provide services to visitors from the "
                "European Union. This regulation fundamentally violates the "
                "right to privacy and anonymous communication."
            ),
            "blocked_show_privacy_stance": True,
        },
        "services": {
            "mail": {
                "enabled": True,
                "domain": "mail.inpriv.xyz",
                "port": 3000,
                "options": {
                    "block_eu_override": False,
                    "max_recipients": 50,
                    "allow_registration": True,
                },
            },
            "totp": {
                "enabled": True,
                "domain": "totp.inpriv.xyz",
                "port": 3010,
                "options": {
                    "block_eu_override": False,
                    "max_accounts_per_user": 50,
                    "rate_limit_login": "5/5min",
                },
            },
            "pay": {
                "enabled": True,
                "domain": "pay.inpriv.xyz",
                "port": None,
                "options": {
                    "block_eu_override": False,
                    "merchant_address": "",
                    "webhook_url": "",
                },
            },
            "zero": {
                "enabled": True,
                "domain": "zero.inpriv.xyz",
                "port": 5000,
                "options": {
                    "block_eu_override": False,
                    "network": "mainnet",
                    "rpc_url": "https://api.mainnet-beta.solana.com",
                    "auto_lock_minutes": 5,
                },
            },
            "hush": {
                "enabled": True,
                "domain": "hush.inpriv.xyz",
                "port": 8000,
                "options": {
                    "block_eu_override": False,
                    "default_model": "meta-llama/llama-3-8b-instruct:free",
                    "searxng_url": "http://localhost:8080",
                },
            },
            "osint": {
                "enabled": True,
                "domain": "osint.inpriv.xyz",
                "port": 8001,
                "options": {
                    "block_eu_override": False,
                    "default_model": "meta-llama/llama-3-8b-instruct:free",
                    "searxng_url": "http://localhost:8080",
                },
            },
        },
    }


# ── GeoIP helper ──────────────────────────────────────────────────────

async def _lookup_country(ip: str) -> str | None:
    """Return ISO country code for *ip*, or None on failure.

    Uses a local cache first, then falls back to a free GeoIP API.
    """
    now = time.time()
    cached = _geoip_cache.get(ip)
    if cached and (now - cached["cached_at"]) < GEOIP_CACHE_TTL:
        return cached["country_code"]

    # Try ip-api.com (free, no key required, 45 req/min limit)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"http://ip-api.com/json/{ip}?fields=countryCode")
            if resp.status_code == 200:
                data = resp.json()
                cc = data.get("countryCode", "")
                if cc:
                    _geoip_cache[ip] = {"country_code": cc, "cached_at": now}
                    return cc
    except Exception:
        pass

    # Fallback: try ipapi.co
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"https://ipapi.co/{ip}/country_code/")
            if resp.status_code == 200:
                cc = resp.text.strip()
                if cc and cc != "Undefined":
                    _geoip_cache[ip] = {"country_code": cc, "cached_at": now}
                    return cc
    except Exception:
        pass

    return None


def _is_eu_country(country_code: str) -> bool:
    return country_code.upper() in EU_COUNTRIES


# ── Request models ────────────────────────────────────────────────────

class ServiceUpdate(BaseModel):
    enabled: bool | None = None
    domain: str | None = None
    port: int | None = None
    options: dict | None = None


class GlobalUpdate(BaseModel):
    block_eu_ips: bool | None = None
    blocked_title: str | None = None
    blocked_message: str | None = None
    blocked_show_privacy_stance: bool | None = None


class ValidateIPRequest(BaseModel):
    ip: str | None = None


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/")
async def serve_panel():
    return FileResponse(str(BASE_DIR / "index.html"))


@app.get("/blocked")
async def serve_blocked():
    return FileResponse(str(BASE_DIR / "blocked.html"))


@app.get("/favicon.ico")
async def favicon():
    fpath = BASE_DIR / "favicon.ico"
    if fpath.exists():
        return FileResponse(str(fpath))
    return Response(status_code=204)


# ── API: Services ─────────────────────────────────────────────────────

@app.get("/api/services")
async def list_services():
    cfg = _load_config()
    return {"services": cfg.get("services", {})}


@app.get("/api/services/{name}")
async def get_service(name: str):
    cfg = _load_config()
    svc = cfg.get("services", {}).get(name)
    if svc is None:
        raise HTTPException(status_code=404, detail=f"Service '{name}' not found")
    return {"service": name, "config": svc}


@app.put("/api/services/{name}")
async def update_service(name: str, update: ServiceUpdate):
    cfg = _load_config()
    svc = cfg.get("services", {}).get(name)
    if svc is None:
        raise HTTPException(status_code=404, detail=f"Service '{name}' not found")

    if update.enabled is not None:
        svc["enabled"] = update.enabled
    if update.domain is not None:
        svc["domain"] = update.domain
    if update.port is not None:
        svc["port"] = update.port
    if update.options is not None:
        svc["options"].update(update.options)

    _save_config(cfg)
    return {"status": "ok", "service": name, "config": svc}


# ── API: Global settings ──────────────────────────────────────────────

@app.get("/api/global")
async def get_global():
    cfg = _load_config()
    return {"global": cfg.get("global", {})}


@app.put("/api/global")
async def update_global(update: GlobalUpdate):
    cfg = _load_config()
    g = cfg.setdefault("global", {})

    if update.block_eu_ips is not None:
        g["block_eu_ips"] = update.block_eu_ips
    if update.blocked_title is not None:
        g["blocked_title"] = update.blocked_title
    if update.blocked_message is not None:
        g["blocked_message"] = update.blocked_message
    if update.blocked_show_privacy_stance is not None:
        g["blocked_show_privacy_stance"] = update.blocked_show_privacy_stance

    _save_config(cfg)
    return {"status": "ok", "global": g}


# ── API: GeoIP / EU validation ────────────────────────────────────────

@app.get("/api/geoip/check")
async def geoip_check(ip: str = ""):
    """Check if a given IP is from the EU. Returns structured result."""
    if not ip or ip in ("127.0.0.1", "::1", "localhost"):
        return {"ip": ip, "country_code": None, "is_eu": False, "blocked": False}

    cc = await _lookup_country(ip)
    is_eu = _is_eu_country(cc) if cc else False

    cfg = _load_config()
    block_enabled = cfg.get("global", {}).get("block_eu_ips", False)

    return {
        "ip": ip,
        "country_code": cc,
        "is_eu": is_eu,
        "blocked": (is_eu and block_enabled),
    }


@app.post("/api/validate-ip")
async def validate_ip(request: Request, body: ValidateIPRequest | None = None):
    """Validate the client's own IP (or a provided one) against EU block.

    Returns whether the request should be blocked, plus the blocked page
    content to show if applicable.
    """
    # Determine IP to check
    if body and body.ip:
        target_ip = body.ip
    else:
        forwarded = request.headers.get("X-Forwarded-For", "")
        target_ip = forwarded.split(",")[0].strip() if forwarded else request.client.host

    # Skip check for local/private IPs
    if target_ip in ("127.0.0.1", "::1", "localhost") or target_ip.startswith(("192.168.", "10.", "172.16.")):
        return {"blocked": False, "reason": None}

    cc = await _lookup_country(target_ip)
    is_eu = _is_eu_country(cc) if cc else False

    cfg = _load_config()
    g = cfg.get("global", {})
    block_enabled = g.get("block_eu_ips", False)

    if is_eu and block_enabled:
        return {
            "blocked": True,
            "reason": "eu_region",
            "title": g.get("blocked_title", "Access Restricted"),
            "message": g.get(
                "blocked_message",
                "Access restricted due to EU regulations.",
            ),
            "show_privacy_stance": g.get("blocked_show_privacy_stance", True),
            "country_code": cc,
        }

    return {"blocked": False, "reason": None, "country_code": cc}


# ── API: Config reset ─────────────────────────────────────────────────

@app.post("/api/reset")
async def reset_config():
    """Reset config to factory defaults."""
    cfg = _default_config()
    _save_config(cfg)
    return {"status": "ok", "message": "Configuration reset to defaults."}


# ── Entrypoint ────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "9000"))

    try:
        print(f"[*] Inpriv Panel starting on http://localhost:{port} ...")
        uvicorn.run(app, host=host, port=port)
    except Exception:
        import traceback

        traceback.print_exc()
        print("\n[!] Failed to start. Common fixes:")
        print("    - pip install -r requirements.txt")
        print("    - Make sure nothing else is using the port.")
        try:
            input("\nPress Enter to close...")
        except EOFError:
            pass
