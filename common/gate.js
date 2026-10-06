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

import { PAGE_CSS, LOGO_SVG, backdropHtml } from "./page.js";

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
<meta name="color-scheme" content="dark light">
<title>${svc} — temporarily unavailable</title>
<style>${PAGE_CSS}</style></head><body>
${backdropHtml()}
<main>
  <a class="brand" href="https://inpriv.xyz/?home">${LOGO_SVG}<span>Inpriv</span></a>
  <section class="card">
    <h1>${svc} is paused.<br><span>It'll be back shortly.</span></h1>
    <p>We're doing some maintenance. Your mail and data are safe.</p>
    ${msg}
    <div class="pill" id="status">Checking again every few seconds</div>
    <div class="actions">
      <a class="btn btn-primary" href="#" onclick="location.reload();return false">Try again</a>
      <a class="btn btn-glass" href="https://inpriv.xyz/?home">inpriv.xyz</a>
    </div>
  </section>
</main>
<script>
  // when the service is unlocked again, reload into it
  (function () {
    var statusEl = document.getElementById('status');
    setInterval(function () {
      fetch(location.href, { method: 'HEAD', cache: 'no-store' })
        .then(function (r) {
          if (r.ok) {
            statusEl.textContent = 'Back online, loading';
            setTimeout(function () { location.reload(); }, 600);
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
