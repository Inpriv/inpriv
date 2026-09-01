"""
wallet.py — Zero Wallet server (v2).
Copyright (c) 2026 Inpriv Labs — MIT License

This server is a THIN, TRUSTLESS relay. It performs NO cryptography and holds
NO keys, NO passwords, NO seeds, and NO session state. It exists only to:

  1. Serve the static single-page app (index.html + style.css + app.js).
  2. Proxy Solana JSON-RPC calls for the browser (avoids CORS + lets operators
     point at a private/paid RPC without a client rebuild).
  3. Proxy SOL/USD pricing (CoinGecko), cached 60s server-side.
  4. Expose a tiny non-secret /api/config for the client.
  5. Optionally honor a panel "service suspension" flag (if configured).

All key generation, encryption, decryption, and transaction signing happen in
the browser. The server forwards opaque bytes it cannot read.

Run:  python wallet.py
Env:  SOLANA_RPC, PORT, HOST, PANEL_CONFIG_PATH, TRUSTED_PROXIES  (see .env.example)
"""

import os
import time
import httpx
from flask import Flask, request, jsonify, render_template, make_response, Response
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SOLANA_RPC = os.environ.get(
    "SOLANA_RPC", "https://api.mainnet-beta.solana.com"
).rstrip("/")

PORT = int(os.environ.get("PORT", "5000"))
HOST = os.environ.get("HOST", "127.0.0.1")

# Optional panel-integration: only active if this path exists.
PANEL_CONFIG_PATH = os.environ.get(
    "PANEL_CONFIG_PATH", os.path.join(BASE_DIR, "..", ".panel", "config.json")
)

TRUSTED_PROXIES = {
    p.strip() for p in os.environ.get("TRUSTED_PROXIES", "127.0.0.1").split(",") if p.strip()
}

# Solana network label derived from the RPC host (best-effort).
def _network_label() -> str:
    h = SOLANA_RPC.lower()
    if "devnet" in h:
        return "devnet"
    if "testnet" in h:
        return "testnet"
    return "mainnet-beta"


NETWORK_LABEL = _network_label()

# ─── App ─────────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

# Rate limiting. honor_x_forwarded_header is set so correct remote IPs are used
# behind a reverse proxy when TRUSTED_PROXIES is configured.
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["120 per minute"],
    storage_uri="memory://",
)


@app.before_request
def _check_panel_suspension():
    """Block traffic if the optional panel config marks 'zero' as disabled.

    Inactive unless PANEL_CONFIG_PATH exists on disk. Fully self-hostable.
    """
    if not PANEL_CONFIG_PATH or not os.path.exists(PANEL_CONFIG_PATH):
        return None
    try:
        import json

        with open(PANEL_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if not cfg.get("services", {}).get("zero", {}).get("enabled", True):
            if request.path.startswith("/api"):
                return jsonify({"error": "Service temporarily suspended"}), 503
            return make_response(_SUSPENDED_HTML, 503, {"Content-Type": "text/html; charset=utf-8"})
    except Exception:
        # Never let a broken panel config take the wallet down.
        return None
    return None


@app.after_request
def _security_headers(resp: Response) -> Response:
    """Strict security headers. CSP forbids inline scripts and third-party
    fetches (Google Fonts are the only allowed external resource)."""
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "frame-ancestors 'none'"
    )
    resp.headers["Content-Security-Policy"] = csp
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # HSTS only makes sense over HTTPS; harmless locally.
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


# ─── Static SPA ──────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ─── Solana JSON-RPC proxy ───────────────────────────────────────────────────

# Allowlist of Solana RPC methods the browser may invoke via the proxy. Keeps
# the relay minimal and predictable. All are read-only except sendTransaction
# (which carries an opaque, already-signed payload the server cannot read).
_ALLOWED_METHODS = {
    "getBalance",
    "getLatestBlockhash",
    "getSignaturesForAddress",
    "getTransaction",
    "sendTransaction",
    "getFeeForMessage",
    "getAccountInfo",
}


@app.route("/api/rpc", methods=["POST"])
@limiter.limit("60 per minute")
def api_rpc():
    """Generic Solana JSON-RPC proxy. Body: {"method": ..., "params": [...]}.

    The server forwards to SOLANA_RPC and returns the upstream JSON verbatim.
    It never inspects or stores private material.
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400

    method = data.get("method")
    params = data.get("params", [])

    if not isinstance(method, str) or method not in _ALLOWED_METHODS:
        return jsonify({"error": f"Method not allowed: {method}"}), 403
    if not isinstance(params, list):
        return jsonify({"error": "params must be a list"}), 400

    payload = {"jsonrpc": "2.0", "id": data.get("id", 1), "method": method, "params": params}

    try:
        with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
            upstream = client.post(SOLANA_RPC, json=payload)
            upstream.raise_for_status()
    except httpx.HTTPError as exc:
        return jsonify({"error": f"Upstream RPC error: {exc}"}), 502

    # Pass the upstream body through as-is (already JSON).
    return Response(upstream.content, status=200, mimetype="application/json")


# ─── SOL price proxy (cached 60s) ────────────────────────────────────────────

_PRICE_CACHE = {"price": 0.0, "time": 0.0}


@app.route("/api/sol-price", methods=["GET"])
@limiter.limit("10 per minute")
def api_sol_price():
    now = time.time()
    if _PRICE_CACHE["price"] and now - _PRICE_CACHE["time"] < 60:
        return jsonify({"price": _PRICE_CACHE["price"]})

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": "solana", "vs_currencies": "usd"},
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            price = float(resp.json().get("solana", {}).get("usd", 0.0))
    except Exception:
        return jsonify({"price": _PRICE_CACHE["price"]})

    if price > 0:
        _PRICE_CACHE["price"] = price
        _PRICE_CACHE["time"] = now
    return jsonify({"price": price or _PRICE_CACHE["price"]})


# ─── Non-secret client config ────────────────────────────────────────────────

@app.route("/api/config", methods=["GET"])
@limiter.limit("30 per minute")
def api_config():
    return jsonify(
        {
            "network": NETWORK_LABEL,
            "rpcLabel": NETWORK_LABEL,
            "version": "2.0.0",
        }
    )


# ─── Health ──────────────────────────────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"ok": True, "version": "2.0.0", "network": NETWORK_LABEL})


# ─── Suspension page (English, used only when panel disables the service) ────

_SUSPENDED_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#13140E">
  <title>Service Paused — Zero</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,400;8..144,500;8..144,600;8..144,700&display=swap" rel="stylesheet">
  <style>
    :root{
      --surface:#13140E; --on-surface:#E3E2D3; --on-surface-variant:#C3C8B6;
      --primary:#ABD37A; --outline-variant:#43483D;
    }
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Roboto Flex',system-ui,sans-serif;background:var(--surface);color:var(--on-surface);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{max-width:440px;width:100%;text-align:center;padding:48px 32px;background:rgba(31,33,27,.7);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--outline-variant);border-radius:24px;box-shadow:0 12px 40px -6px rgba(0,0,0,.65)}
    .icon{width:64px;height:64px;border-radius:50%;margin:0 auto 24px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--primary) 18%,transparent);color:var(--primary);font-size:32px}
    h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin-bottom:12px}
    p{color:var(--on-surface-variant);line-height:1.6;font-size:15px}
  </style>
</head>
<body>
  <main class="card">
    <div class="icon" aria-hidden="true">&#9208;</div>
    <h1>Service temporarily paused</h1>
    <p>This wallet has been paused by its administrator. Your funds are safe on the Solana blockchain &mdash; please try again later.</p>
  </main>
</body>
</html>"""


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import socket

    print(f"  Zero Wallet v2.0.0  ({NETWORK_LABEL})")
    print(f"  RPC endpoint : {SOLANA_RPC}")
    print(f"  Self-custodial: all crypto runs in the browser. This server holds no keys.")

    # Cheap pre-flight: is the port already in use?
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    port_in_use = sock.connect_ex((HOST, PORT)) == 0
    sock.close()

    url = f"http://{'127.0.0.1' if HOST == '0.0.0.0' else HOST}:{PORT}"
    print(f"  Listening on {url}")

    if port_in_use:
        print(f"  Port {PORT} is already in use — open {url} in your browser, or set PORT.")
    else:
        # threaded=True so the RPC proxy can serve concurrent requests.
        app.run(host=HOST, port=PORT, debug=False, threaded=True)
