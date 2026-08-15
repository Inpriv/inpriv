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
     background:radial-gradient(ellipse 80% 50% at 50% -10%,#1e2416,transparent),#13140e;color:#e3e2d3}
.box{max-width:480px;padding:48px 40px;text-align:center}
.icon{font-size:3rem;margin-bottom:16px}
h1{font-size:1.6rem;font-weight:600;margin-bottom:12px;color:#e3e2d3}
p{color:#c7c6b8;font-size:.95rem}
.msg{margin-top:14px;padding:12px 16px;border-radius:12px;background:#1e2416;color:#abd37a;display:inline-block}
a{color:#abd37a;text-decoration:none;font-size:.85rem}
a:hover{text-decoration:underline}
</style></head><body><div class="box">
<div class="icon">🔒</div>
<h1>${escapeHtml(serviceName)} is temporarily unavailable</h1>
<p>This service has been locked by the administrator.<br>Your data is safe — check back later.</p>
${msg}
<p style="margin-top:24px;font-size:.8rem"><a href="https://inpriv.xyz">← inpriv.xyz</a></p>
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
