// ── Inpriv error pages (shared) ──────────────────────────────────────────────
// Minimal, typographic error pages for every Inpriv service. Flat dark
// background, oversized status number, one line of copy, one quiet action.
// No icons, no cards, no gradients — nothing decorative.
//
// Usage in a worker:
//   import { notFound, notFoundPage, forbiddenPage, gonePage,
//            tooManyRequestsPage, serverErrorPage } from "../common/errors.js";
//
//   const res = await env.ASSETS.fetch(request);
//   if (res.status === 404) return notFound(request, "Inpriv QR");
//   return res;
//
// Every page is standalone (zero external requests), noindex, no-store.

const ESC = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function errorPage({ status, title, heading, intro, extra, primary, noteHtml }) {
  const extraHtml = extra
    ? `<p class="msg">${ESC(extra)}</p>`
    : "";
  const primaryHtml = primary
    ? `<a class="btn" href="${ESC(primary.href)}"${primary.reload ? ' rel="nofollow"' : ""}>${ESC(primary.label)}</a>`
    : "";
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${ESC(title)}</title>
<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100svh;display:grid;place-items:center;background:#13140E;color:#E3E2D3;
     font:16px/1.6 'Roboto Flex',system-ui,-apple-system,sans-serif;padding:24px;
     -webkit-font-smoothing:antialiased}
main{max-width:420px;width:100%;animation:fade .4s cubic-bezier(.2,1.4,0,1) both}
@keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
.code{font-size:88px;font-weight:200;line-height:1;letter-spacing:-.04em;color:#43483D;
      margin-bottom:20px;font-variant-numeric:tabular-nums}
h1{font-size:1.15rem;font-weight:600;letter-spacing:-.01em;margin-bottom:8px;color:#E3E2D3}
p{color:#8D9283;font-size:.9rem;line-height:1.6}
p a{color:#ABD37A;text-decoration:none}
p a:hover{text-decoration:underline}
.msg{margin-top:16px;padding:10px 14px;border-left:2px solid #ABD37A;background:#1A1C17;
     border-radius:0 10px 10px 0;color:#C7C6B8;font-size:.85rem;word-break:break-word}
.actions{margin-top:28px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;padding:10px 22px;border-radius:9999px;
     border:1px solid #43483D;color:#E3E2D3;text-decoration:none;font-size:.88rem;font-weight:600;
     transition:border-color .2s,color .2s,transform .2s cubic-bezier(.2,1.4,0,1)}
.btn:hover{border-color:#ABD37A;color:#C7EFA0;transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.home{color:#8D9283;font-size:.85rem;text-decoration:none;transition:color .2s}
.home:hover{color:#C7EFA0}
</style></head><body>
<main>
  <div class="code">${status}</div>
  <h1>${ESC(heading)}</h1>
  <p>${intro}</p>
  ${extraHtml}
  <div class="actions">
    ${primaryHtml}
    <a class="home" href="https://inpriv.xyz">inpriv.xyz</a>
  </div>
  ${noteHtml || ""}
</main>
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

const HOME = { label: "Go home", href: "/" };
const RETRY = { label: "Try again", href: "#", reload: true };

export function notFoundPage(serviceName) {
  return errorPage({
    status: 404,
    title: `Page not found — ${serviceName}`,
    heading: "Page not found",
    intro: "The address may be mistyped, or the page may have moved.",
    primary: HOME,
  });
}

export function forbiddenPage(serviceName, reason) {
  return errorPage({
    status: 403,
    title: `Access restricted — ${serviceName}`,
    heading: "Access restricted",
    intro: "You don't have access to this page. If it's yours, sign in first.",
    extra: reason,
    primary: HOME,
  });
}

export function gonePage(serviceName, reason) {
  return errorPage({
    status: 410,
    title: `Expired — ${serviceName}`,
    heading: "Gone",
    intro:
      "Whatever lived here was set to expire — and it did. When time's up, it's gone for good.",
    extra: reason,
    primary: HOME,
  });
}

export function tooManyRequestsPage(serviceName, reason) {
  return errorPage({
    status: 429,
    title: `Too many requests — ${serviceName}`,
    heading: "Too many requests",
    intro: "A short pause — give it a minute, then try again.",
    extra: reason,
    primary: RETRY,
  });
}

export function serverErrorPage(serviceName, reason) {
  return errorPage({
    status: 500,
    title: `Something went wrong — ${serviceName}`,
    heading: "Something went wrong",
    intro:
      'That\'s on our side, not yours. Your data was not affected.<br>If it keeps happening, check <a href="https://status.inpriv.xyz">status.inpriv.xyz</a>.',
    extra: reason,
    primary: RETRY,
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
