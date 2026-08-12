"""
hush — Zero-knowledge E2EE WebSocket relay server with Admin Panel.

Requirements: pip install aiohttp
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import secrets
import string
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from aiohttp import web, WSMsgType, ClientSession, ClientTimeout

# ── Environment Loader ────────────────────────────────────────────────────────
def load_env() -> None:
    """Load variables from .env file into os.environ if it exists."""
    if os.path.exists(".env"):
        with open(".env", "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    # Strip surrounding whitespace and quotes
                    os.environ[key.strip()] = val.strip().strip("'\"")

load_env()

# ── Configuration ────────────────────────────────────────────────────────────
HOST = os.environ.get("HUSH_HOST", "0.0.0.0")
PORT = int(os.environ.get("HUSH_PORT", "80"))

ADMIN_USERNAME = os.environ.get("HUSH_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("HUSH_ADMIN_PASSWORD")

if not ADMIN_USERNAME or not ADMIN_PASSWORD:
    raise RuntimeError(
        "Critical Error: HUSH_ADMIN_USERNAME and HUSH_ADMIN_PASSWORD "
        "must be configured in your environment or .env file."
    )

ID_PREFIX = "hush-"
ID_DIGITS = 4
REGISTRATION_TIMEOUT = 10.0
MAX_FRAME_SIZE = 10 * 1024 * 1024  # 10 MB limit for E2EE file transfers

# ── In-memory registries ─────────────────────────────────────────────────────

@dataclass
class Session:
    ws: web.WebSocketResponse
    pubkey: str
    room_id: Optional[str] = None
    ip: Optional[str] = None

@dataclass
class Room:
    id: str
    expires_at: float
    history_limit: int  # Max age of cached messages in seconds
    clients: Set[str] = field(default_factory=set)
    history: List[dict] = field(default_factory=list) # Encrypted blobs cached in RAM

clients: Dict[str, Session] = {}
rooms: Dict[str, Room] = {}
admin_sessions: Set[str] = set()  # Tracks active admin tokens in RAM (zero-persistence)

# ── EU Geoblock Configuration ────────────────────────────────────────────────
EU_COUNTRIES = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
    "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
    "SI", "ES", "SE"
}

ip_country_cache: Dict[str, tuple[str, float]] = {}
CACHE_TTL = 3600  # 1 hour
aiohttp_client: Optional[ClientSession] = None


async def init_client(app: web.Application) -> None:
    """Initialize shared aiohttp client for geolocation lookups."""
    global aiohttp_client
    aiohttp_client = ClientSession(timeout=ClientTimeout(total=3))


async def close_client(app: web.Application) -> None:
    """Cleanup shared aiohttp client."""
    global aiohttp_client
    if aiohttp_client:
        await aiohttp_client.close()


async def get_country_code(ip: str, request: web.Request) -> Optional[str]:
    """Resolve IP to ISO country code. Checks Cloudflare header first, then API."""
    # Cloudflare passes the country in a header when proxying
    cf_country = request.headers.get("CF-IPCountry")
    if cf_country and cf_country.upper() != "XX":
        return cf_country.upper()

    now = time.time()
    cached = ip_country_cache.get(ip)
    if cached:
        country, ts = cached
        if now - ts < CACHE_TTL:
            return country

    if aiohttp_client is None:
        return None

    try:
        async with aiohttp_client.get(f"http://ipapi.co/{ip}/country_code/") as resp:
            if resp.status == 200:
                country = (await resp.text()).strip().upper()
                ip_country_cache[ip] = (country, now)
                return country
    except Exception:
        pass
    return None


async def _is_eu_ip(ip: str, request: Optional[web.Request] = None) -> bool:
    """Return True if the given IP resolves to an EU country."""
    country = await get_country_code(ip, request)
    return country is not None and country in EU_COUNTRIES


async def check_geoblock(request: web.Request) -> bool:
    """Return True if the request should be blocked based on EU geoblock."""
    if not SYSTEM_STATE.get("eu_geoblock", False):
        return False

    # Determine real client IP (Cloudflare / reverse-proxy aware)
    ip = request.headers.get("X-Forwarded-For", request.remote or "")
    if "," in ip:
        ip = ip.split(",")[0].strip()
    if not ip:
        return False  # Allow if IP cannot be determined (safer than blocking)

    return await _is_eu_ip(ip, request)

# ── Administrative Controls ──────────────────────────────────────────────────
SYSTEM_STATE = {
    "lock_down": False,
    "text_only": False,
    "under_attack": False,
    "eu_geoblock": False
}


ADMIN_LOGIN_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>hush · login</title>
    <style>
        :root {
            --bg: #020208;
            --text: #f5f5f7;
            --text-muted: rgba(235, 235, 245, 0.5);
            --glass-bg-heavy: rgba(15, 15, 15, 0.4);
            --glass-border: rgba(255, 255, 255, 0.12);
            --glass-border-light: rgba(255, 255, 255, 0.08);
            --button-bg: rgba(255, 255, 255, 0.07);
            --button-hover: rgba(255, 255, 255, 0.15);
            --accent: rgba(255, 255, 255, 0.14);
            --accent-hover: rgba(255, 255, 255, 0.24);
            --shadow-heavy: 0 24px 64px rgba(0,0,0,0.7);
            --shadow-modal: 0 32px 80px rgba(0,0,0,0.75);
            color-scheme: dark;
            --ios-ease: cubic-bezier(0.32, 0.72, 0, 1);
            --spring-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body {
            margin: 0; padding: 0;
            background: var(--bg); color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex; align-items: center; justify-content: center;
            height: 100vh; overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }

        /* 4 Liquid Glass Orbs */
        .bg-layer { position: fixed; inset: 0; z-index: -1; overflow: hidden; background: #020208; }
        .bg-orb { position: absolute; border-radius: 50%; filter: blur(140px); will-change: transform; }
        .bg-orb-1 { width:70vw; height:70vw; background:radial-gradient(circle at 40% 40%, rgba(67,24,155,0.7) 0%, rgba(30,10,80,0.3) 35%, transparent 70%); top:-28%; left:-18%; animation:orbFloat1 30s ease-in-out infinite alternate; mix-blend-mode:screen; }
        .bg-orb-2 { width:58vw; height:58vw; background:radial-gradient(circle at 50% 50%, rgba(120,50,200,0.6) 0%, rgba(40,20,100,0.25) 35%, transparent 70%); top:55%; right:-20%; animation:orbFloat2 35s ease-in-out infinite alternate; mix-blend-mode:screen; }
        .bg-orb-3 { width:50vw; height:50vw; background:radial-gradient(circle at 50% 50%, rgba(15,100,120,0.55) 0%, rgba(5,40,50,0.25) 35%, transparent 70%); bottom:-25%; left:30%; animation:orbFloat3 28s ease-in-out infinite alternate; mix-blend-mode:screen; }
        .bg-orb-4 { width:45vw; height:45vw; background:radial-gradient(circle at 50% 50%, rgba(30,80,200,0.5) 0%, rgba(10,30,80,0.2) 40%, transparent 70%); top:-15%; right:15%; animation:orbFloat4 32s ease-in-out infinite alternate; mix-blend-mode:soft-light; }
        @keyframes orbFloat1 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(5%,8%) scale(1.1) rotate(3deg)} 66%{transform:translate(-3%,4%) scale(.95) rotate(-2deg)} 100%{transform:translate(7%,-3%) scale(1.08) rotate(5deg)} }
        @keyframes orbFloat2 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(-6%,-4%) scale(1.12) rotate(-4deg)} 66%{transform:translate(4%,-7%) scale(.93) rotate(2deg)} 100%{transform:translate(-8%,3%) scale(1.06) rotate(-3deg)} }
        @keyframes orbFloat3 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(-4%,6%) scale(1.08) rotate(2deg)} 66%{transform:translate(6%,-3%) scale(.96) rotate(-3deg)} 100%{transform:translate(-5%,-5%) scale(1.1) rotate(4deg)} }
        @keyframes orbFloat4 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(7%,-5%) scale(1.05) rotate(-2deg)} 66%{transform:translate(-5%,6%) scale(1.1) rotate(3deg)} 100%{transform:translate(3%,-7%) scale(.97) rotate(-4deg)} }

        /* Frosted Glass Login Card */
        .login-card {
            background: var(--glass-bg-heavy);
            backdrop-filter: blur(40px) saturate(220%);
            -webkit-backdrop-filter: blur(40px) saturate(220%);
            border: 1px solid var(--glass-border);
            border-radius: 28px; padding: 36px;
            width: 90%; max-width: 400px;
            box-shadow: var(--shadow-heavy), inset 0 1px 0 rgba(255,255,255,0.06);
            transform: scale(0.88) translateY(20px);
            animation: popIn 0.45s var(--spring-ease) forwards;
            text-align: center;
        }
        @keyframes popIn { from { opacity:0; transform:scale(0.88) translateY(20px); } to { opacity:1; transform:scale(1) translateY(0); } }
        h2 { margin:0 0 8px; font-size:22px; font-weight:650; letter-spacing:-0.5px; }
        p { font-size:13px; color:var(--text-muted); margin:0 0 24px; line-height:1.5; }
        .input-group { margin-bottom:16px; text-align:left; }
        label { display:block; font-size:11px; color:var(--text-muted); margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px; font-weight:600; }
        input {
            width:100%; padding:14px 20px; border-radius:9999px;
            background:rgba(255,255,255,0.06); border:1px solid var(--glass-border-light);
            color:var(--text); font-size:16px; outline:none;
            transition:all 0.35s var(--ios-ease);
            backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px);
        }
        input:focus {
            border-color:rgba(255,255,255,0.25); background:rgba(255,255,255,0.1);
            box-shadow:0 0 0 3px rgba(255,255,255,0.04), 0 0 40px rgba(10,132,255,0.12);
        }
        input::placeholder { color:rgba(255,255,255,0.28); }
        .modal-btn {
            width:100%; padding:14px 24px; border-radius:9999px;
            background:var(--accent); border:1px solid var(--glass-border-light);
            color:var(--text); font-weight:600; font-size:15px; cursor:pointer;
            transition:all 0.2s var(--ios-ease); margin-top:10px;
            backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px);
        }
        .modal-btn:hover { background:var(--accent-hover); transform:scale(1.02); border-color:rgba(255,255,255,0.2); }
        .modal-btn:active { transform:scale(0.95); }

        /* iOS Sheet Alert */
        .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,0.55); backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%); z-index:100; display:flex; align-items:center; justify-content:center; opacity:0; pointer-events:none; transition:opacity 0.35s var(--ios-ease); }
        .modal-bg.visible { opacity:1; pointer-events:auto; }
        .alert-card {
            background:var(--glass-bg-heavy); backdrop-filter:blur(40px) saturate(220%);
            -webkit-backdrop-filter:blur(40px) saturate(220%); border:1px solid var(--glass-border);
            border-radius:28px; padding:28px; width:90%; max-width:340px; text-align:center;
            box-shadow:var(--shadow-modal), inset 0 1px 0 rgba(255,255,255,0.06);
            transform:scale(0.88) translateY(20px); transition:transform 0.4s var(--spring-ease);
        }
        .modal-bg.visible .alert-card { transform:scale(1) translateY(0); }
        .alert-title { margin:0 0 10px; font-size:18px; font-weight:600; }
        .alert-message { margin:0 0 20px; font-size:14px; color:var(--text-muted); line-height:1.5; }
    </style>
</head>
<body>
    <div class="bg-layer">
        <div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div>
        <div class="bg-orb bg-orb-3"></div><div class="bg-orb bg-orb-4"></div>
    </div>
    <div class="login-card">
        <h2>hush · panel login</h2>
        <p>Access the administrative dashboard. Authorization credentials required.</p>
        <form id="login-form">
            <div class="input-group">
                <label for="username">Username</label>
                <input type="text" id="username" required autocomplete="username" placeholder="Enter username...">
            </div>
            <div class="input-group">
                <label for="password">Password</label>
                <input type="password" id="password" required autocomplete="current-password" placeholder="••••••••">
            </div>
            <button type="submit" class="modal-btn">Log In</button>
        </form>
    </div>
    <div id="alert-modal" class="modal-bg">
        <div class="alert-card">
            <h3 id="alert-title" class="alert-title">Alert</h3>
            <p id="alert-message" class="alert-message"></p>
            <button class="modal-btn" type="button" style="max-width:140px; margin:0 auto; display:block;" onclick="hideAlert()">OK</button>
        </div>
    </div>
    <script>
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const u = document.getElementById('username').value;
            const p = document.getElementById('password').value;
            try {
                const res = await fetch('/panel/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
                const result = await res.json();
                if (result.status === 'success') { window.location.reload(); }
                else { showAlert('Login failed', result.message || 'Invalid credentials'); }
            } catch(err) { showAlert('Error', 'Connection error. Please try again.'); }
        });
        function showAlert(title, message) {
            document.getElementById('alert-title').innerText = title;
            document.getElementById('alert-message').innerText = message;
            document.getElementById('alert-modal').classList.add('visible');
        }
        function hideAlert() { document.getElementById('alert-modal').classList.remove('visible'); }
    </script>
</body>
</html>
"""


ADMIN_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>hush · panel</title>
    <style>
        :root {
            --bg: #020208; --text: #f5f5f7;
            --text-muted: rgba(235,235,245,0.5);
            --glass-bg-heavy: rgba(15,15,15,0.4);
            --glass-border: rgba(255,255,255,0.12);
            --glass-border-light: rgba(255,255,255,0.08);
            --button-bg: rgba(255,255,255,0.07);
            --button-hover: rgba(255,255,255,0.15);
            --accent: rgba(255,255,255,0.14);
            --accent-hover: rgba(255,255,255,0.24);
            --shadow-heavy: 0 24px 64px rgba(0,0,0,0.7);
            --shadow-modal: 0 32px 80px rgba(0,0,0,0.75);
            --shadow-float: 0 8px 32px rgba(0,0,0,0.5);
            color-scheme: dark;
            --ios-ease: cubic-bezier(0.32,0.72,0,1);
            --spring-ease: cubic-bezier(0.22,0.61,0.36,1);
        }
        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
        html,body { margin:0; padding:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; overflow:hidden; height:100vh; -webkit-font-smoothing:antialiased; }

        /* Liquid Glass Orbs */
        .panel-bg { position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; padding:16px; overflow:hidden; }
        .bg-orb { position:absolute; border-radius:50%; filter:blur(140px); will-change:transform; z-index:-1; }
        .bg-orb-1 { width:70vw; height:70vw; background:radial-gradient(circle at 40% 40%, rgba(67,24,155,0.7) 0%, rgba(30,10,80,0.3) 35%, transparent 70%); top:-28%; left:-18%; animation:orbFloat1 30s ease-in-out infinite alternate; mix-blend-mode:screen; opacity:0.5; }
        .bg-orb-2 { width:58vw; height:58vw; background:radial-gradient(circle at 50% 50%, rgba(120,50,200,0.6) 0%, rgba(40,20,100,0.25) 35%, transparent 70%); top:55%; right:-20%; animation:orbFloat2 35s ease-in-out infinite alternate; mix-blend-mode:screen; opacity:0.5; }
        .bg-orb-3 { width:50vw; height:50vw; background:radial-gradient(circle at 50% 50%, rgba(15,100,120,0.55) 0%, rgba(5,40,50,0.25) 35%, transparent 70%); bottom:-25%; left:30%; animation:orbFloat3 28s ease-in-out infinite alternate; mix-blend-mode:screen; opacity:0.45; }
        @keyframes orbFloat1 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(5%,8%) scale(1.1) rotate(3deg)} 66%{transform:translate(-3%,4%) scale(.95) rotate(-2deg)} 100%{transform:translate(7%,-3%) scale(1.08) rotate(5deg)} }
        @keyframes orbFloat2 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(-6%,-4%) scale(1.12) rotate(-4deg)} 66%{transform:translate(4%,-7%) scale(.93) rotate(2deg)} 100%{transform:translate(-8%,3%) scale(1.06) rotate(-3deg)} }
        @keyframes orbFloat3 { 0%{transform:translate(0,0) scale(1) rotate(0deg)} 33%{transform:translate(-4%,6%) scale(1.08) rotate(2deg)} 66%{transform:translate(6%,-3%) scale(.96) rotate(-3deg)} 100%{transform:translate(-5%,-5%) scale(1.1) rotate(4deg)} }

        /* Frosted Glass Card */
        .modal-card {
            background:var(--glass-bg-heavy); backdrop-filter:blur(40px) saturate(220%);
            -webkit-backdrop-filter:blur(40px) saturate(220%); border:1px solid var(--glass-border);
            border-radius:28px; padding:28px; width:90%; max-width:540px;
            box-shadow:var(--shadow-heavy), inset 0 1px 0 rgba(255,255,255,0.06);
            transform:scale(0.88) translateY(20px);
            animation:popIn 0.45s var(--spring-ease) forwards;
            transform-origin:center; position:relative; z-index:1;
        }
        @keyframes popIn { from { opacity:0; transform:scale(0.88) translateY(20px); } to { opacity:1; transform:scale(1) translateY(0); } }
        .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; gap:12px; }
        .modal-header h2 { margin:0; font-size:20px; font-weight:600; letter-spacing:-0.4px; }
        .modal-close {
            background:var(--button-bg); border:1px solid var(--glass-border-light); color:var(--text);
            width:36px; height:36px; border-radius:50%; cursor:pointer;
            display:flex; align-items:center; justify-content:center; font-size:18px;
            transition:all 0.2s var(--ios-ease); flex-shrink:0;
            backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px);
        }
        .modal-close:hover { background:var(--button-hover); transform:scale(1.1); }
        .modal-close:active { transform:scale(0.92); }
        .subtext { font-size:13px; color:var(--text-muted); line-height:1.5; margin:0 0 16px; }
        .grid { display:grid; gap:12px; }
        .row {
            display:flex; justify-content:space-between; align-items:center; gap:16px;
            padding:14px 16px; border:1px solid var(--glass-border-light); border-radius:20px;
            background:rgba(0,0,0,0.18); backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px);
            transition:background 0.2s var(--ios-ease);
        }
        .row:hover { background:rgba(255,255,255,0.03); }
        .label-group { display:flex; flex-direction:column; gap:4px; }
        .row-title { font-size:14px; font-weight:700; }
        .row-desc { font-size:12px; color:var(--text-muted); line-height:1.4; }

        .switch { position:relative; display:inline-block; width:51px; height:31px; flex-shrink:0; }
        .switch input { opacity:0; width:0; height:0; }
        .slider {
            position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0;
            background-color:var(--button-bg); transition:.4s var(--ios-ease);
            border-radius:34px; border:1px solid var(--glass-border-light);
        }
        .slider:before {
            position:absolute; content:""; height:25px; width:25px; left:2px; bottom:2px;
            background-color:white; transition:.4s var(--ios-ease);
            border-radius:50%; box-shadow:0 3px 8px rgba(0,0,0,0.3);
        }
        input:checked+.slider { background-color:#30d158; border-color:rgba(48,209,88,0.3); }
        input:checked+.slider:before { transform:translateX(20px); }
        .modal-actions { margin-top:16px; display:flex; gap:10px; }

        .modal-btn {
            width:100%; padding:14px 24px; border-radius:9999px;
            background:var(--accent); border:1px solid var(--glass-border-light);
            color:var(--text); font-weight:600; font-size:15px; cursor:pointer;
            transition:all 0.2s var(--ios-ease);
            backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px);
        }
        .modal-btn:hover { background:var(--accent-hover); transform:scale(1.02); border-color:rgba(255,255,255,0.2); }
        .modal-btn:active { transform:scale(0.95); }

        .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,0.55); backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%); z-index:100; display:flex; align-items:center; justify-content:center; opacity:0; pointer-events:none; transition:opacity 0.35s var(--ios-ease); }
        .modal-bg.visible { opacity:1; pointer-events:auto; }
        .alert-card {
            background:var(--glass-bg-heavy); backdrop-filter:blur(40px) saturate(220%);
            -webkit-backdrop-filter:blur(40px) saturate(220%); border:1px solid var(--glass-border);
            border-radius:28px; padding:28px; width:90%; max-width:340px; text-align:center;
            box-shadow:var(--shadow-modal), inset 0 1px 0 rgba(255,255,255,0.06);
            transform:scale(0.88) translateY(20px); transition:transform 0.4s var(--spring-ease);
        }
        .modal-bg.visible .alert-card { transform:scale(1) translateY(0); }
        .alert-title { margin:0 0 10px; font-size:18px; font-weight:600; }
        .alert-message { margin:0 0 20px; font-size:14px; color:var(--text-muted); line-height:1.5; }

        .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11px; color:rgba(255,255,255,0.25); letter-spacing:0.4px; text-transform:uppercase; }
    </style>
</head>
<body>
    <div class="panel-bg">
        <div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div><div class="bg-orb bg-orb-3"></div>
        <div class="modal-card">
            <div class="modal-header">
                <h2>hush · system panel</h2>
                <button id="close-panel" class="modal-close" type="button" title="Close">✕</button>
            </div>
            <p class="subtext">Toggle platform state instantly. Changes propagate to active terminals.</p>
            <div class="mono">Endpoint: /panel · Cookie Session</div>
            <div style="height:14px;"></div>
            <div class="grid">
                <div class="row">
                    <div class="label-group">
                        <span class="row-title">Lockdown Mode</span>
                        <span class="row-desc">Suspends services and logs off clients.</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="lock-down" onchange="updateSettings()">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="row">
                    <div class="label-group">
                        <span class="row-title">Text-Only Mode</span>
                        <span class="row-desc">Disables file/image transmission.</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="text-only" onchange="updateSettings()">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="row">
                    <div class="label-group">
                        <span class="row-title">Under Attack Mode</span>
                        <span class="row-desc">Forces cryptographic proof-of-work check.</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="under-attack" onchange="updateSettings()">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="row">
                    <div class="label-group">
                        <span class="row-title">EU Geoblock</span>
                        <span class="row-desc">Blocks all European Union IP addresses from accessing the service.</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="eu-geoblock" onchange="updateSettings()">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            <div class="modal-actions">
                <button class="modal-btn" type="button" onclick="refreshState()">Refresh</button>
            </div>
        </div>
    </div>
    <div id="alert-modal" class="modal-bg">
        <div class="alert-card">
            <h3 id="alert-title" class="alert-title">Alert</h3>
            <p id="alert-message" class="alert-message"></p>
            <button class="modal-btn" type="button" style="max-width:140px; margin:0 auto; display:block;" onclick="hideAlert()">OK</button>
        </div>
    </div>
    <script>
        const settings = {{SETTINGS}};
        document.getElementById('lock-down').checked = settings.lock_down;
        document.getElementById('text-only').checked = settings.text_only;
        document.getElementById('under-attack').checked = settings.under_attack;
        document.getElementById('eu-geoblock').checked = settings.eu_geoblock;
        function showAlert(title, message) {
            document.getElementById('alert-title').innerText = title;
            document.getElementById('alert-message').innerText = message;
            document.getElementById('alert-modal').classList.add('visible');
        }
        function hideAlert() { document.getElementById('alert-modal').classList.remove('visible'); }
        async function updateSettings() {
            const data = {
                lock_down: document.getElementById('lock-down').checked,
                text_only: document.getElementById('text-only').checked,
                under_attack: document.getElementById('under-attack').checked,
                eu_geoblock: document.getElementById('eu-geoblock').checked
            };
            try {
                const res = await fetch('/panel/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (result.status !== 'success') { showAlert('Update failed', result.message || 'Failed to update settings'); }
            } catch(e) { showAlert('Connection error', 'Could not reach panel update endpoint.'); }
        }
        async function refreshState() { window.location.reload(); }
        document.getElementById('close-panel').addEventListener('click', () => window.close());
    </script>
</body>
</html>
"""


LOCKDOWN_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>hush · suspended</title>
    <style>
        :root { --bg:#020208; --text:#f5f5f7; --text-muted:rgba(235,235,245,0.5); --glass-bg-heavy:rgba(15,15,15,0.4); --glass-border:rgba(255,255,255,0.12); --shadow-heavy:0 24px 64px rgba(0,0,0,0.7); --ios-ease:cubic-bezier(0.32,0.72,0,1); --spring-ease:cubic-bezier(0.22,0.61,0.36,1); }
        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
        body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; overflow:hidden; -webkit-font-smoothing:antialiased; }
        .bg-layer { position:fixed; inset:0; z-index:-1; overflow:hidden; background:#020208; }
        .bg-orb { position:absolute; border-radius:50%; filter:blur(140px); will-change:transform; }
        .bg-orb-1 { width:65vw; height:65vw; background:radial-gradient(circle at 40% 40%, rgba(67,24,155,0.55) 0%, transparent 70%); top:-22%; left:-12%; animation:float1 25s ease-in-out infinite alternate; mix-blend-mode:screen; }
        .bg-orb-2 { width:50vw; height:50vw; background:radial-gradient(circle at 50% 50%, rgba(180,40,40,0.35) 0%, transparent 70%); bottom:-18%; right:-12%; animation:float2 28s ease-in-out infinite alternate; mix-blend-mode:screen; }
        @keyframes float1 { 0%{transform:translate(0,0) scale(1)} 100%{transform:translate(6%,5%) scale(1.1)} }
        @keyframes float2 { 0%{transform:translate(0,0) scale(1)} 100%{transform:translate(-5%,-6%) scale(1.12)} }
        .card {
            background:var(--glass-bg-heavy); backdrop-filter:blur(40px) saturate(220%);
            -webkit-backdrop-filter:blur(40px) saturate(220%); border:1px solid var(--glass-border);
            border-radius:28px; padding:44px; text-align:center; max-width:440px; width:90%;
            box-shadow:var(--shadow-heavy), inset 0 1px 0 rgba(255,255,255,0.06);
            animation:popIn 0.45s var(--spring-ease) forwards;
            transform:scale(0.88) translateY(20px);
        }
        @keyframes popIn { from { opacity:0; transform:scale(0.88) translateY(20px); } to { opacity:1; transform:scale(1) translateY(0); } }
        h2 { margin:0 0 12px; font-size:20px; font-weight:650; letter-spacing:-0.4px; }
        p { font-size:13px; color:var(--text-muted); line-height:1.6; margin:0 0 24px; }
        .code { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11px; color:rgba(255,255,255,0.18); text-transform:uppercase; letter-spacing:0.5px; }

    </style>
</head>
<body>
    <div class="bg-layer">
        <div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div>
    </div>
    <div class="card">
        <h2>Service Temporarily Suspended</h2>
        <p>The platform is undergoing brief maintenance or security validation. Service will be restored shortly. Thank you for your patience.</p>
        <div class="code">Error Code: HUSH_SYS_LOCKDOWN</div>
    </div>
    <script>
        setInterval(async () => {
            try {
                const res = await fetch("/");
                if (res.ok) {
                    const text = await res.text();
                    if (!text.includes("HUSH_SYS_LOCKDOWN")) { window.location.reload(); }
                }
            } catch (e) { }
        }, 3000);
    </script>
</body>
</html>
"""

EU_GEOBLOCK_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>hush · access restricted</title>
    <style>
        :root { --bg:#020208; --text:#f5f5f7; --text-muted:rgba(235,235,245,0.5); --glass-bg-heavy:rgba(15,15,15,0.4); --glass-border:rgba(255,255,255,0.12); --shadow-heavy:0 24px 64px rgba(0,0,0,0.7); --ios-ease:cubic-bezier(0.32,0.72,0,1); --spring-ease:cubic-bezier(0.22,0.61,0.36,1); }
        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
        body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; overflow:hidden; -webkit-font-smoothing:antialiased; }
        .bg-layer { position:fixed; inset:0; z-index:-1; overflow:hidden; background:#020208; }
        .bg-orb { position:absolute; border-radius:50%; filter:blur(140px); will-change:transform; }
        .bg-orb-1 { width:65vw; height:65vw; background:radial-gradient(circle at 40% 40%, rgba(67,24,155,0.55) 0%, transparent 70%); top:-22%; left:-12%; animation:float1 25s ease-in-out infinite alternate; mix-blend-mode:screen; }
        .bg-orb-2 { width:50vw; height:50vw; background:radial-gradient(circle at 50% 50%, rgba(200,140,40,0.35) 0%, transparent 70%); bottom:-18%; right:-12%; animation:float2 28s ease-in-out infinite alternate; mix-blend-mode:screen; }
        @keyframes float1 { 0%{transform:translate(0,0) scale(1)} 100%{transform:translate(6%,5%) scale(1.1)} }
        @keyframes float2 { 0%{transform:translate(0,0) scale(1)} 100%{transform:translate(-5%,-6%) scale(1.12)} }
        .card {
            background:var(--glass-bg-heavy); backdrop-filter:blur(40px) saturate(220%);
            -webkit-backdrop-filter:blur(40px) saturate(220%); border:1px solid var(--glass-border);
            border-radius:28px; padding:44px; text-align:center; max-width:440px; width:90%;
            box-shadow:var(--shadow-heavy), inset 0 1px 0 rgba(255,255,255,0.06);
            animation:popIn 0.45s var(--spring-ease) forwards;
            transform:scale(0.88) translateY(20px);
        }
        @keyframes popIn { from { opacity:0; transform:scale(0.88) translateY(20px); } to { opacity:1; transform:scale(1) translateY(0); } }
        h2 { margin:0 0 12px; font-size:20px; font-weight:650; letter-spacing:-0.4px; }
        p { font-size:13px; color:var(--text-muted); line-height:1.6; margin:0 0 24px; }
        .code { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11px; color:rgba(255,255,255,0.18); text-transform:uppercase; letter-spacing:0.5px; }
    </style>
</head>
<body>
    <div class="bg-layer">
        <div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div>
    </div>
    <div class="card">
        <h2>Access Restricted</h2>
        <p>This service is unavailable in the European Union due to regional restrictions. End-to-end encryption is incompatible with proposed legislation such as Chat Control 2.0, which mandates scanning of private communications.</p>
        <div class="code">Error Code: HUSH_EU_GEOBLOCK</div>
    </div>
    <script>
        setInterval(async () => {
            try {
                const res = await fetch("/");
                if (res.ok) {
                    const text = await res.text();
                    if (!text.includes("HUSH_EU_GEOBLOCK")) { window.location.reload(); }
                }
            } catch (e) { }
        }, 3000);
    </script>
</body>
</html>
"""


def _generate_id(prefix: str, length: int) -> str:
    """Return a unique random ID."""
    while True:
        cid = prefix + "".join(secrets.choice(string.digits) for _ in range(length))
        if cid not in clients and cid not in rooms:
            return cid


async def _send(ws: web.WebSocketResponse, payload: dict) -> None:
    """Best-effort JSON send; silently ignore broken pipes."""
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def _broadcast_user_list() -> None:
    """Push the current {id: pubkey} map to every connected global client."""
    users = {cid: s.pubkey for cid, s in clients.items() if s.room_id is None}
    payload = {"type": "users", "users": users}
    for session in list(clients.values()):
        if session.room_id is None:
            await _send(session.ws, payload)


async def _broadcast_room_list(room_id: str) -> None:
    """Push the user list to all clients in a specific room."""
    room = rooms.get(room_id)
    if not room:
        return
    users = [cid for cid in room.clients if cid in clients]
    payload = {"type": "room_users", "room_id": room_id, "users": users}
    for cid in list(room.clients):
        if cid in clients:
            await _send(clients[cid].ws, payload)


def _prune_room_history(room: Room):
    """Remove expired messages from the room's RAM history."""
    if room.history_limit <= 0:
        return
    now = time.time()
    room.history = [m for m in room.history if (now - m["ts"]) <= room.history_limit]


async def _room_cleaner() -> None:
    """Background task to delete expired rooms and wipe their RAM history."""
    while True:
        await asyncio.sleep(3600)  # Check every hour
        now = time.time()
        expired = [rid for rid, r in rooms.items() if r.expires_at <= now]
        for rid in expired:
            room = rooms.pop(rid, None)
            if room:
                for cid in list(room.clients):
                    if cid in clients:
                        await _send(clients[cid].ws, {"type": "room_expired", "room_id": rid})
                        clients[cid].room_id = None
                await _broadcast_user_list()


async def _close_eu_sessions() -> None:
    """Close all active WebSocket connections from EU IP addresses."""
    if not SYSTEM_STATE.get("eu_geoblock", False):
        return
    for cid, session in list(clients.items()):
        if session.ip and await _is_eu_ip(session.ip):
            try:
                await session.ws.close(code=4001, message="Geoblocked region.")
            except Exception:
                pass
            clients.pop(cid, None)


async def _eu_geoblock_enforcer() -> None:
    """Background task: periodically close any EU sessions while geoblock is active."""
    while True:
        await asyncio.sleep(10)
        if SYSTEM_STATE.get("eu_geoblock", False):
            await _close_eu_sessions()


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    """Handle WebSocket connections and relay encrypted messages."""
    if SYSTEM_STATE["lock_down"]:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.close(code=4000, message="Service suspended.")
        return ws

    if await check_geoblock(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.close(code=4001, message="Geoblocked region.")
        return ws

    ws = web.WebSocketResponse(max_msg_size=MAX_FRAME_SIZE)
    await ws.prepare(request)

    client_id: Optional[str] = None

    try:
        # ── Phase 1: Registration ──────────────────────────────────────
        try:
            msg = await asyncio.wait_for(ws.receive_json(), timeout=REGISTRATION_TIMEOUT)
        except (asyncio.TimeoutError, Exception):
            return ws

        if msg.get("type") != "register" or not msg.get("pubkey"):
            return ws

        # Capture real client IP
        client_ip = request.headers.get("X-Forwarded-For", request.remote or "")
        if "," in client_ip:
            client_ip = client_ip.split(",")[0].strip()

        client_id = _generate_id(ID_PREFIX, ID_DIGITS)
        clients[client_id] = Session(ws=ws, pubkey=msg["pubkey"], ip=client_ip)

        await _send(ws, {"type": "registered", "id": client_id})
        await _send(ws, {"type": "sys_state", "state": SYSTEM_STATE})
        await _broadcast_user_list()

        # ── Phase 2: Message Relay Loop ────────────────────────────────
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue

            try:
                data = msg.json()
            except Exception:
                continue

            mtype = data.get("type")
            session = clients.get(client_id)

            if mtype == "key_request":
                target = data.get("target")
                peer = clients.get(target)
                if peer:
                    await _send(ws, {"type": "key_response", "target": target, "pubkey": peer.pubkey})
                else:
                    await _send(ws, {"type": "key_not_found", "target": target})

            elif mtype == "relay":
                target = data.get("target")
                peer = clients.get(target)
                if peer and data.get("payload"):
                    if SYSTEM_STATE["text_only"]:
                        try:
                            payload_data = json.loads(data["payload"])
                            if payload_data.get("isFile"):
                                await _send(ws, {"type": "error", "message": "File sharing is disabled by administrator."})
                                continue
                        except Exception:
                            pass
                    await _send(peer.ws, {"type": "relay", "from": client_id, "payload": data["payload"]})

            elif mtype == "global_relay":
                for rid, enc in (data.get("recipients") or {}).items():
                    if rid == client_id:
                        continue
                    peer = clients.get(rid)
                    if peer and peer.room_id is None:
                        await _send(peer.ws, {"type": "global", "from": client_id, "payload": enc})

            elif mtype == "typing":
                target = data.get("target")
                peer = clients.get(target)
                if peer:
                    await _send(peer.ws, {"type": "typing", "from": client_id})

            elif mtype == "room_typing":
                if session and session.room_id:
                    room = rooms.get(session.room_id)
                    if room:
                        for cid in list(room.clients):
                            if cid != client_id and cid in clients:
                                await _send(clients[cid].ws, {"type": "room_typing", "from": client_id})

            elif mtype == "create_room":
                duration_map = {
                    "1h": 3600, "12h": 43200, "1d": 86400, "7d": 604800,
                    "1m": 2592000, "6m": 15552000, "1y": 31536000, "always": float('inf')
                }
                duration = duration_map.get(data.get("duration"), 3600)
                
                hist_str = data.get("history_limit", "always")
                if hist_str == "off":
                    history_limit = 0
                else:
                    history_limit = duration_map.get(hist_str, float('inf'))

                room_id = _generate_id("room-", 6)
                rooms[room_id] = Room(id=room_id, expires_at=time.time() + duration, history_limit=history_limit)
                await _send(ws, {"type": "room_created", "room_id": room_id})

            elif mtype == "join_room":
                room_id = data.get("room_id")
                room = rooms.get(room_id)
                if room:
                    if session.room_id:
                        prev_room = rooms.get(session.room_id)
                        if prev_room:
                            prev_room.clients.discard(client_id)
                            await _broadcast_room_list(session.room_id)
                    
                    session.room_id = room_id
                    room.clients.add(client_id)
                    await _send(ws, {"type": "room_joined", "room_id": room_id})
                    
                    _prune_room_history(room)
                    if room.history:
                        await _send(ws, {"type": "room_history", "messages": room.history})
                    
                    await _broadcast_room_list(room_id)
                    await _broadcast_user_list()
                else:
                    await _send(ws, {"type": "error", "message": "Room expired or not found."})

            elif mtype == "leave_room":
                if session and session.room_id:
                    room = rooms.get(session.room_id)
                    if room:
                        room.clients.discard(client_id)
                        await _broadcast_room_list(session.room_id)
                    session.room_id = None
                    await _send(ws, {"type": "room_left"})
                    await _broadcast_user_list()

            elif mtype == "room_relay":
                if session and session.room_id:
                    room = rooms.get(session.room_id)
                    if room:
                        payload = data.get("payload")
                        if SYSTEM_STATE["text_only"]:
                            try:
                                payload_data = json.loads(payload)
                                if payload_data.get("isFile"):
                                    await _send(ws, {"type": "error", "message": "File sharing is disabled by administrator."})
                                    continue
                            except Exception:
                                pass
                        room.history.append({"ts": time.time(), "from": client_id, "payload": payload})
                        _prune_room_history(room)
                        for cid in list(room.clients):
                            if cid != client_id and cid in clients:
                                await _send(clients[cid].ws, {"type": "room_msg", "from": client_id, "payload": payload})

            elif mtype == "ping":
                await _send(ws, {"type": "pong"})

    except Exception:
        pass
    finally:
        if client_id and clients.get(client_id):
            session = clients[client_id]
            if session.room_id:
                room = rooms.get(session.room_id)
                if room:
                    room.clients.discard(client_id)
                    await _broadcast_room_list(session.room_id)
            clients.pop(client_id, None)
            await _broadcast_user_list()

    return ws


async def index_handler(request: web.Request) -> web.Response:
    """Serve the HTML web client."""
    if SYSTEM_STATE["lock_down"]:
        return web.Response(text=LOCKDOWN_HTML, content_type="text/html")

    if await check_geoblock(request):
        return web.Response(text=EU_GEOBLOCK_HTML, content_type="text/html", status=403)

    try:
        with open("index.html", "rb") as f:
            body = f.read()
        
        # Inject Server-Side State Variables dynamically
        state_json = json.dumps(SYSTEM_STATE)
        body = body.replace(b'window.SYS_STATE = {"lock_down": false, "text_only": false, "under_attack": false};', f'window.SYS_STATE = {state_json};'.encode('utf-8'))
        
        return web.Response(body=body, content_type="text/html")
    except FileNotFoundError:
        return web.Response(text="index.html not found", status=404)


async def icon_handler(request: web.Request) -> web.Response:
    """Serve the favicon icon with explicit cache disabling."""
    try:
        with open("icon.png", "rb") as f:
            return web.Response(
                body=f.read(), 
                content_type="image/png",
                headers={
                    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
            )
    except FileNotFoundError:
        return web.Response(status=404)


# ── Administration Panel Routing ─────────────────────────────────────────────

def _is_authenticated(request: web.Request) -> bool:
    """Verify administrator identity via cookie session."""
    token = request.cookies.get("hush_session")
    return token is not None and token in admin_sessions


async def admin_handler(request: web.Request) -> web.Response:
    """Serve either the styled dashboard or the custom login interface."""
    if not _is_authenticated(request):
        return web.Response(text=ADMIN_LOGIN_HTML, content_type="text/html")
    
    html = ADMIN_HTML.replace("{{SETTINGS}}", json.dumps(SYSTEM_STATE))
    return web.Response(text=html, content_type="text/html")


async def admin_login_handler(request: web.Request) -> web.Response:
    """Process login credentials and issue a secure session cookie."""
    try:
        data = await request.json()
        username = data.get("username")
        password = data.get("password")
        
        if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
            token = secrets.token_hex(32)
            admin_sessions.add(token)
            
            response = web.json_response({"status": "success"})
            response.set_cookie(
                "hush_session",
                token,
                path="/",
                httponly=True,
                samesite="Strict"
            )
            return response
        return web.json_response({"status": "error", "message": "Invalid credentials"}, status=401)
    except Exception:
        return web.json_response({"status": "error", "message": "Malformed request"}, status=400)


async def admin_redirect_handler(request: web.Request) -> web.Response:
    """Redirect /admin to the correct /panel endpoint."""
    raise web.HTTPFound("/panel")


async def admin_update_handler(request: web.Request) -> web.Response:
    """Perform hot-swapping configurations over core registers."""
    if not _is_authenticated(request):
        return web.json_response({"status": "error", "message": "Unauthorized"}, status=401)

    try:
        data = await request.json()
        SYSTEM_STATE["lock_down"] = bool(data.get("lock_down", False))
        SYSTEM_STATE["text_only"] = bool(data.get("text_only", False))
        SYSTEM_STATE["under_attack"] = bool(data.get("under_attack", False))
        SYSTEM_STATE["eu_geoblock"] = bool(data.get("eu_geoblock", False))

        payload = {"type": "sys_state", "state": SYSTEM_STATE}

        if SYSTEM_STATE["lock_down"]:
            # Drop all messaging sockets on lockdown
            for session in list(clients.values()):
                await session.ws.close(code=4000, message="Service suspended.")
        elif SYSTEM_STATE["eu_geoblock"]:
            # Drop all EU sessions immediately when geoblock is toggled on
            await _close_eu_sessions()
            # Propagate state to remaining (non-EU) clients
            for session in list(clients.values()):
                await _send(session.ws, payload)
        else:
            # Propagate updated system parameters to active sockets
            for session in list(clients.values()):
                await _send(session.ws, payload)

        return web.json_response({"status": "success", "state": SYSTEM_STATE})
    except Exception:
        return web.json_response({"status": "error", "message": "Failed to store state"})


async def main() -> None:
    """Entry point: silence all logging, start the server, await shutdown."""
    for name in ("aiohttp", "asyncio", "websockets"):
        logging.getLogger(name).setLevel(logging.CRITICAL + 1)

    app = web.Application()
    app.router.add_get("/", index_handler)
    app.router.add_get("/index.html", index_handler)
    app.router.add_get("/icon.png", icon_handler)
    app.router.add_get("/ws", websocket_handler)
    
    # Administrative control endpoints
    app.router.add_get("/admin", admin_redirect_handler)
    app.router.add_get("/panel", admin_handler)
    app.router.add_post("/panel/login", admin_login_handler)
    app.router.add_post("/panel/update", admin_update_handler)

    app.on_startup.append(init_client)
    app.on_cleanup.append(close_client)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    
    print(f"[hush] listening on {HOST}:{PORT} (zero-log · zero-persistence)", flush=True)
    
    await site.start()
    asyncio.create_task(_room_cleaner())
    asyncio.create_task(_eu_geoblock_enforcer())

    stop_event = asyncio.Event()
    await stop_event.wait()

    print("[hush] shutdown complete", flush=True)
    await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass