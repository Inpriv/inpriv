// ── Inpriv error pages (shared) ──────────────────────────────────────────────
// Branded error pages for every Inpriv service, in the same visual language
// as common/gate.js maintenancePage (glass card, M3 Earthy Forest, inline SVG).
//
// Usage in a worker:
//   import { notFound, notFoundPage, forbiddenPage, gonePage,
//            tooManyRequestsPage, serverErrorPage } from "../common/errors.js";
//
//   // Smart 404 — JSON for API/img requests, HTML page for navigation:
//   const res = await env.ASSETS.fetch(request);
//   if (res.status === 404) return notFound(request, "Inpriv QR");
//   return res;
//
// Every page is standalone (zero external requests), noindex, no-store.
// Copy is friendly and human — never admin-speak — and always offers a way
// out (primary action + link back to https://inpriv.xyz).

const ESC = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

// Icon accents per severity. Green = neutral state, amber = temporary/caution
// (red reads as breakage — see maintenance-page notes), red = genuine error.
const TONES = {
  green: { bg: "#2E4F2F", fg: "#C7EFA0" },
  amber: { bg: "#3A3323", fg: "#E8C77A" },
  red:   { bg: "#3B2724", fg: "#FFB4AB" },
};

const ICONS = {
  // compass — "you're off the map" (404)
  compass:
    '<circle cx="12" cy="12" r="10"></circle>' +
    '<polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>',
  // padlock — private / no access (403)
  lock:
    '<rect x="3" y="11" width="18" height="11" rx="2"></rect>' +
    '<path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
  // hourglass — expired / gone (410)
  hourglass:
    '<path d="M5 22h14"></path><path d="M5 2h14"></path>' +
    '<path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"></path>' +
    '<path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"></path>',
  // clock — slow down / rate limit (429)
  clock:
    '<circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path>',
  // alert — something broke on our side (500)
  alert:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
    '<line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
};

function errorPage({ status, tone, icon, title, heading, intro, extra, primary, note }) {
  const toneC = TONES[tone] || TONES.green;
  const extraHtml = extra
    ? `<p class="msg">${ESC(extra)}</p>`
    : "";
  const primaryHtml = primary
    ? `<a class="btn" href="${ESC(primary.href)}"${primary.reload ? ' onclick="location.reload();return false"' : ""}>${ESC(primary.label)}${primary.iconSvg || ""}</a><br>`
    : "";
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${ESC(title)}</title>
<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:grid;place-items:center;
     font:16px/1.6 'Roboto Flex',system-ui,-apple-system,sans-serif;
     background:radial-gradient(ellipse 80% 50% at 50% -10%,#1e2416,transparent),#13140e;
     color:#e3e2d3;padding:20px;-webkit-font-smoothing:antialiased}
.box{max-width:460px;width:100%;padding:52px 40px;text-align:center;
     background:rgba(26,28,23,0.85);backdrop-filter:blur(28px) saturate(180%);-webkit-backdrop-filter:blur(28px) saturate(180%);
     border:1px solid rgba(141,146,131,0.25);border-radius:28px;
     box-shadow:0 16px 48px -8px rgba(0,0,0,0.6);
     animation:rise .5s cubic-bezier(0.2,1.4,0,1) both}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.box{animation:none}}
.icon{width:68px;height:68px;border-radius:20px;background:${toneC.bg};color:${toneC.fg};
      display:grid;place-items:center;margin:0 auto 22px;box-shadow:0 8px 24px rgba(0,0,0,0.35)}
.icon svg{width:32px;height:32px;stroke:${toneC.fg}}
h1{font-size:1.4rem;font-weight:700;letter-spacing:-0.01em;margin-bottom:10px;color:#e3e2d3}
p{color:#c7c6b8;font-size:.92rem;line-height:1.55}
.code{display:inline-block;margin-bottom:14px;padding:4px 12px;border-radius:9999px;
      background:#1F211B;border:1px solid #43483D;color:#8d9283;
      font-size:.75rem;font-weight:700;letter-spacing:.12em}
.msg{margin:18px auto 0;padding:12px 18px;border-radius:14px;background:#1E2416;
     border:1px solid #3D4B34;color:#ABD37A;font-weight:500;display:inline-block;word-break:break-word;max-width:100%}
.btn{display:inline-flex;align-items:center;gap:8px;margin-top:28px;padding:12px 26px;
     border-radius:9999px;background:#ABD37A;color:#173800;font-weight:700;font-size:.92rem;
     text-decoration:none;transition:transform .2s cubic-bezier(0.2,1.4,0,1),box-shadow .2s;
     box-shadow:0 6px 20px -4px rgba(171,211,122,0.45)}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 26px -4px rgba(171,211,122,0.55)}
.btn:active{transform:translateY(0)}
.btn svg{width:17px;height:17px;stroke:#173800}
.home{display:inline-block;margin-top:16px;color:#8d9283;text-decoration:none;font-size:.85rem;transition:color .2s}
.home:hover{color:#c7efa0}
.note{margin-top:22px;font-size:.8rem;color:#8d9283}
@media (max-width:420px){.box{padding:40px 24px}}
</style></head><body>
<div class="box">
  <div class="icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.compass}</svg>
  </div>
  <div class="code">${status}</div>
  <h1>${ESC(heading)}</h1>
  <p>${intro}</p>
  ${extraHtml}
  <br>
  ${primaryHtml}
  <a class="home" href="https://inpriv.xyz">Browse other Inpriv tools</a>
  ${note ? `<div class="note">${ESC(note)}</div>` : ""}
</div>
</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(status === 429 ? { "retry-after": "60" } : {}),
      },
    }
  );
}

function jsonError(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

// ── Concrete pages ───────────────────────────────────────────────────────────

export function notFoundPage(serviceName) {
  return errorPage({
    status: 404,
    tone: "green",
    icon: "compass",
    title: `Page not found — ${serviceName}`,
    heading: "This page doesn't exist",
    intro:
      "The address may be mistyped, or the page may have moved.<br>Nothing was lost — everything else is right where you left it.",
    primary: {
      label: "Go to the homepage",
      href: "/",
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path></svg>',
    },
  });
}

export function forbiddenPage(serviceName, reason) {
  return errorPage({
    status: 403,
    tone: "amber",
    icon: "lock",
    title: `Access restricted — ${serviceName}`,
    heading: "This one stays private",
    intro:
      "You don't have access to this page.<br>If it's yours, sign in first — if not, it's simply not meant to be opened.",
    extra: reason,
    primary: {
      label: "Go to the homepage",
      href: "/",
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path></svg>',
    },
  });
}

export function gonePage(serviceName, reason) {
  return errorPage({
    status: 410,
    tone: "amber",
    icon: "hourglass",
    title: `Expired — ${serviceName}`,
    heading: "This has expired",
    intro:
      "Whatever lived at this address was set to disappear — and it did.<br>That's the privacy promise working as intended: when time's up, it's gone for good.",
    extra: reason,
    primary: {
      label: "Go to the homepage",
      href: "/",
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path></svg>',
    },
  });
}

export function tooManyRequestsPage(serviceName, reason) {
  return errorPage({
    status: 429,
    tone: "amber",
    icon: "clock",
    title: `Slow down — ${serviceName}`,
    heading: "A short pause",
    intro:
      "Too many requests arrived at once, so this page is catching its breath.<br>Give it a minute and try again — everything is safe.",
    extra: reason,
    primary: {
      label: "Try again",
      href: "#",
      reload: true,
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
    },
  });
}

export function serverErrorPage(serviceName, reason) {
  return errorPage({
    status: 500,
    tone: "red",
    icon: "alert",
    title: `Something went wrong — ${serviceName}`,
    heading: "Something went wrong",
    intro:
      "That's on us, not you. The hiccup is on our side, and it's usually gone in a moment.<br>Your data was not affected.",
    extra: reason,
    note: "If it keeps happening, check status.inpriv.xyz",
    primary: {
      label: "Try again",
      href: "#",
      reload: true,
      iconSvg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
    },
  });
}

// ── Smart helpers ────────────────────────────────────────────────────────────

// HTML only for human navigation (Accept header), JSON for API/img fetches.
function wantsHtml(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

// Smart 404: JSON for /api/* and non-browser requests, branded page otherwise.
export function notFound(request, serviceName) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/") || !wantsHtml(request)) {
    return jsonError(404, "Not found");
  }
  return notFoundPage(serviceName);
}

// Same idea for 500s raised inside workers.
export function serverError(request, serviceName, reason) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/") || !wantsHtml(request)) {
    return jsonError(500, "Internal error");
  }
  return serverErrorPage(serviceName, reason);
}
