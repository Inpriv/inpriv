// ── Inpriv error pages (shared) ──────────────────────────────────────────────
// Small standalone error pages for every Inpriv Worker, in the same look as
// the apps (see common/page.js): a glass card over faint drifting letters,
// the status number, one line of copy and one clear action.
//
// Usage in a worker:
//   import { notFound, notFoundPage, forbiddenPage, gonePage,
//            tooManyRequestsPage, serverErrorPage } from "../common/errors.js";
//
//   const res = await env.ASSETS.fetch(request);
//   if (res.status === 404) return notFound(request, "Inpriv Mail");
//   return res;
//
// Every page is standalone (zero external requests), noindex, no-store.
import { PAGE_CSS, LOGO_SVG, backdropHtml } from "./page.js";

const ESC = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function errorPage({ status, title, heading, intro, extra, primary, noteHtml }) {
  const extraHtml = extra
    ? `<p class="msg">${ESC(extra)}</p>`
    : "";
  const primaryHtml = primary
    ? `<a class="btn btn-primary" href="${ESC(primary.href)}"${primary.reload ? ' rel="nofollow" onclick="location.reload();return false"' : ""}>${ESC(primary.label)}</a>`
    : "";
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<title>${ESC(title)}</title>
<style>${PAGE_CSS}</style></head><body>
${backdropHtml()}
<main>
  <a class="brand" href="https://inpriv.xyz/?home">${LOGO_SVG}<span>Inpriv</span></a>
  <section class="card">
    <div class="code">${status}</div>
    <h1>${ESC(heading)}</h1>
    <p>${intro}</p>
    ${extraHtml}
    <div class="actions">
      ${primaryHtml}
      <a class="btn btn-glass" href="https://inpriv.xyz/?home">inpriv.xyz</a>
    </div>
    ${noteHtml || ""}
  </section>
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
      "What was here was set to expire, and it has. Once it's gone, it's gone for good.",
    extra: reason,
    primary: HOME,
  });
}

export function tooManyRequestsPage(serviceName, reason) {
  return errorPage({
    status: 429,
    title: `Too many requests — ${serviceName}`,
    heading: "Too many requests",
    intro: "Give it a minute, then try again.",
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
