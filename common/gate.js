// ── Inpriv maintenance gate (shared) ─────────────────────────────────────────
// Drop-in kill-switch for every Inpriv service. Each worker fetches
// /public/state from admin.inpriv.xyz (edge cache ~2 s) and, when its service
// id (or the global switch) is locked, serves a 503 maintenance page.
// The maintenance page auto-retries every 5 s and reloads when unlocked.
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
  const svc = escapeHtml(serviceName);
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${svc} — temporarily unavailable</title>
<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:grid;place-items:center;
     font:16px/1.6 'Roboto Flex',system-ui,-apple-system,sans-serif;
     background:radial-gradient(ellipse 80% 50% at 50% -10%,#242229,transparent),#141218;
     color:#E6E1E3;padding:20px;-webkit-font-smoothing:antialiased}
.box{max-width:460px;width:100%;padding:52px 40px;text-align:center;
     background:rgba(26,28,23,0.85);backdrop-filter:blur(28px) saturate(180%);-webkit-backdrop-filter:blur(28px) saturate(180%);
     border:1px solid rgba(141,146,131,0.25);border-radius:28px;
     box-shadow:0 16px 48px -8px rgba(0,0,0,0.6);
     animation:rise .5s cubic-bezier(0.2,1.4,0,1) both}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.box{animation:none}}
.icon{width:68px;height:68px;border-radius:20px;background:#4B21BD;color:#E6DEFF;
      display:grid;place-items:center;margin:0 auto 22px;box-shadow:0 8px 24px rgba(0,0,0,0.35)}
.icon svg{width:32px;height:32px;stroke:#E6DEFF}
h1{font-size:1.4rem;font-weight:700;letter-spacing:-0.01em;margin-bottom:10px;color:#E6E1E3}
p{color:#CBC4D4;font-size:.92rem;line-height:1.55}
.msg{margin:18px auto 0;padding:12px 18px;border-radius:14px;background:#1E2416;
     border:1px solid #47464F;color:#CBBEFF;font-weight:500;display:inline-block;word-break:break-word;max-width:100%}
.status{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:6px 14px;
        border-radius:9999px;background:#3A373F;color:#E6E1E3;font-size:.8rem;font-weight:600;letter-spacing:.03em}
.btn{display:inline-flex;align-items:center;gap:8px;margin-top:28px;padding:12px 26px;
     border-radius:9999px;background:#CBBEFF;color:#340098;font-weight:700;font-size:.92rem;
     text-decoration:none;transition:transform .2s cubic-bezier(0.2,1.4,0,1),box-shadow .2s;
     box-shadow:0 6px 20px -4px rgba(171,211,122,0.45)}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 26px -4px rgba(171,211,122,0.55)}
.btn:active{transform:translateY(0)}
.btn svg{width:17px;height:17px;stroke:#340098}
.home{display:inline-block;margin-top:16px;color:#948F99;text-decoration:none;font-size:.85rem;transition:color .2s}
.home:hover{color:#E6DEFF}
</style></head><body>
<div class="box">
  <div class="icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M12 6v6l4 2"></path>
    </svg>
  </div>
  <h1>${svc} is taking a short break</h1>
  <p>This service is paused for maintenance.<br>Everything is safe — it will be back shortly.</p>
  ${msg}
  <div class="status">Paused — checking availability…</div>
  <br>
  <a class="btn" href="#" onclick="location.reload();return false">
    Try again
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path>
    </svg>
  </a>
  <br>
  <a class="home" href="https://inpriv.xyz">Browse other Inpriv tools</a>
</div>
<script>
  // Auto-retry: when the service is unlocked, return to it automatically.
  (function () {
    var tries = 0;
    var statusEl = document.querySelector('.status');
    setInterval(function () {
      tries++;
      fetch(location.href, { method: 'HEAD', cache: 'no-store' })
        .then(function (r) {
          if (r.ok) {
            statusEl.innerHTML = 'Back online — loading…';
            setTimeout(function () { location.reload(); }, 600);
          } else if (statusEl && tries % 5 === 0) {
            statusEl.innerHTML = 'Still paused — will keep checking';
          }
        })
        .catch(function () {});
    }, 5000);
  })();
</script>
</body></html>`,
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
