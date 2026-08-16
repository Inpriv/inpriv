// ── Inpriv maintenance gate (shared) ─────────────────────────────────────────
// Drop-in kill-switch for every Inpriv service. Each worker fetches
// /public/state from admin.inpriv.xyz (edge cache ~2 s) and, when its service
// id (or the global switch) is locked, serves a 503 maintenance page.
// /api/health always passes so monitoring keeps working.
//
// Usage in a worker:
//   import { maintenanceGate, maintenancePage } from "../common/gate.js";
//   const gate = await maintenanceGate("stego");            // {locked, message, info}
//   if (gate.locked && path !== "/api/health") return maintenancePage(gate.message);
//
// Single-page tools served via Workers-assets: keep a small "gate.js" import
// plus a run_worker_first wrangler flag, or simply point the domain at a
// routed worker that proxies. We use the import approach.

const GATE_URL = "https://admin.inpriv.xyz/public/state";
const GATE_TTL_MS = 3000;

const cache = { data: null, until: 0 };

export async function maintenanceGate(serviceId) {
  const now = Date.now();
  if (cache.data && cache.until > now) {
    return project(cache.data, serviceId);
  }
  let st = null;
  try {
    const res = await fetch(GATE_URL, {
      headers: { "User-Agent": "inpriv-gate" },
      cf: { cacheTtl: 2, cacheEverything: true },
    });
    st = await res.json();
    cache.data = st;
    cache.until = now + GATE_TTL_MS;
  } catch {
    // fail open — services stay up when the admin panel is unreachable
    cache.data = null;
    cache.until = now + 2000;
    return { locked: false, message: "", info: null };
  }
  return project(st, serviceId);
}

function project(st, serviceId) {
  const svc = (st.services && st.services[serviceId]) || { locked: false, message: "" };
  const locked = !!(st.global && st.global.locked) || !!svc.locked;
  const message =
    (st.global && st.global.locked && st.global.message) || svc.message || "";
  const info = st.info && st.info.active ? st.info.message : null;
  return { locked, message, info };
}

export function maintenancePage(serviceName, message) {
  const msg = message
    ? `<p class="msg">${escapeHtml(message)}</p>`
    : "";
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(serviceName)} — under maintenance</title>
<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,-apple-system,sans-serif;
     background:radial-gradient(ellipse 80% 50% at 50% -10%,#1e2416,transparent),#13140e;color:#e3e2d3;padding:20px}
.box{max-width:480px;padding:48px 36px;text-align:center;background:rgba(26,28,23,0.85);backdrop-filter:blur(24px);border:1px solid rgba(141,146,131,0.25);border-radius:28px;box-shadow:0 16px 48px -8px rgba(0,0,0,0.6)}
.icon{width:64px;height:64px;border-radius:20px;background:#2E4F2F;color:#C7EFA0;display:grid;place-items:center;margin:0 auto 20px;box-shadow:0 8px 24px rgba(0,0,0,0.35)}
.icon svg{width:30px;height:30px;stroke:#C7EFA0}
h1{font-size:1.45rem;font-weight:700;letter-spacing:-0.01em;margin-bottom:10px;color:#e3e2d3}
p{color:#c7c6b8;font-size:.92rem;line-height:1.55}
.msg{margin-top:16px;padding:12px 18px;border-radius:14px;background:#1E2416;border:1px solid #3D4B34;color:#ABD37A;font-weight:500;display:inline-block;word-break:break-word}
a{color:#abd37a;text-decoration:none;font-size:.85rem;font-weight:500;transition:opacity .2s}
a:hover{opacity:.8;text-decoration:underline}
</style></head><body><div class="box">
<div class="icon">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
  </svg>
</div>
<h1>${escapeHtml(serviceName)} is temporarily unavailable</h1>
<p>This service has been locked by the administrator.<br>Your data is safe — check back later.</p>
${msg}
<p style="margin-top:24px;font-size:.85rem"><a href="https://inpriv.xyz">&larr; back to inpriv.xyz</a></p>
</div></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "300",
        "cache-control": "no-store",
      },
    }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
