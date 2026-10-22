// ── Inpriv request and response security (shared) ───────────────────────────
// Response headers for every page, the Content-Security-Policy with hashes of
// the page's own inline scripts (so no other inline script can run), the
// same-origin check for state-changing requests, and the IP helpers used for
// rate limits and logs.

const enc = new TextEncoder();

// ── IP helpers ───────────────────────────────────────────────────────────────
// Rate-limit key: the full IPv4 address, or the /64 an IPv6 user is given.
// Only used inside short-lived counters (rl_counters, deleted within hours).
export function clientKey(request) {
  const ip = (request.headers.get("CF-Connecting-IP") || "").trim();
  if (!ip) return "unknown";
  if (ip.includes(":")) return ipv6Groups(ip).slice(0, 4).join(":") + "::/64";
  return ip;
}

// Network for logs: IPv4 /24 ("203.0.113.0/24") or IPv6 /48. This narrows a
// request to a provider and area. It is not anonymous: combined with times
// and an account, it can still point to a person.
export function clientNet(request) {
  const ip = (request.headers.get("CF-Connecting-IP") || "").trim();
  if (!ip) return null;
  if (ip.includes(":")) return ipv6Groups(ip).slice(0, 3).join(":") + "::/48";
  const p = ip.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x))) return null;
  return `${p[0]}.${p[1]}.${p[2]}.0/24`;
}

function ipv6Groups(ip) {
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? Array(Math.max(0, 8 - a.length - b.length)).fill("0") : [];
  return [...a, ...fill, ...b].map((g) => (g.replace(/^0+(?=.)/, "") || "0"));
}

// Browser family and OS only ("Firefox · Linux"), never the full user agent.
export function uaFamily(ua) {
  const s = String(ua || "");
  let browser = "Unknown";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\//.test(s)) browser = "Opera";
  else if (/Chrome\//.test(s) && !/Chromium|Edg|OPR/.test(s)) browser = "Chrome";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  let os = "Unknown OS";
  if (/Windows/.test(s)) os = "Windows";
  else if (/Android/.test(s)) os = "Android";
  else if (/iPhone|iPad/.test(s)) os = "iOS";
  else if (/Mac OS X/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";
  return `${browser} · ${os}`;
}

// ── same-origin check ────────────────────────────────────────────────────────
// State-changing requests must come from one of the allowed pages. Browsers
// always send Origin on POST, PUT and DELETE; a missing or foreign Origin
// means a form or script on another site, so the request is refused. This
// stops cross-site and sibling-subdomain request forgery even where a cookie
// would be sent.
export function originAllowed(request, allowed) {
  const o = request.headers.get("Origin");
  if (!o) return false;
  const url = new URL(request.url);
  if (o === url.origin) return true;
  // `wrangler dev` rewrites a page's own Origin to its host without the
  // port; only on loopback, never for a real host
  if (/^(127\.0\.0\.1|localhost)$/.test(url.hostname) && o === `${url.protocol}//${url.hostname}`) return true;
  return !!(allowed && allowed.has(o));
}

export function isUnsafeMethod(request) {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

// ── page headers ─────────────────────────────────────────────────────────────
const BASE_HEADERS = {
  // one year, this host only. includeSubDomains / preload come later, once
  // every name under inpriv.xyz is known to serve HTTPS.
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
  "X-DNS-Prefetch-Control": "off",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()",
};

export function withHeaders(response, extra = {}) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...extra })) res.headers.set(k, v);
  return res;
}

// API responses: never stored by a browser or shared cache.
export function apiHeaders(response) {
  const res = withHeaders(response, { "Cache-Control": "no-store" });
  res.headers.delete("X-Frame-Options");
  return res;
}

// sha256 of every inline script in a page, in CSP source form. Scripts with
// src= and JSON-LD blocks don't run inline code, so they need no hash.
async function scriptHashes(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs) || /application\/ld\+json/i.test(attrs)) continue;
    // the HTML parser turns CRLF into LF before the hash is checked
    const body = m[2].replace(/\r\n?/g, "\n");
    const d = await crypto.subtle.digest("SHA-256", enc.encode(body));
    out.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`);
  }
  return out;
}

const _cspCache = new Map();

// Build the policy for an HTML page served from ASSETS. `policy` overrides or
// extends directives, e.g. { "connect-src": ["https://id.inpriv.xyz"] }.
export async function pageResponse(request, response, policy = {}) {
  const type = response.headers.get("Content-Type") || "";
  if (!type.includes("text/html") || response.status !== 200) return withHeaders(response);
  const html = await response.text();
  const key = new URL(request.url).pathname + "|" + html.length + "|" + JSON.stringify(policy);
  let csp = _cspCache.get(key);
  if (!csp) {
    const hashes = await scriptHashes(html);
    const d = {
      "default-src": ["'self'"],
      "script-src": ["'self'", ...hashes],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "frame-src": ["'none'"],
      "worker-src": ["'self'"],
      "manifest-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      // 'self' rather than 'none': the mail readers render messages in a
      // srcdoc frame, which inherits this policy
      "frame-ancestors": ["'self'"],
    };
    // "frame-src": [...] adds sources; "=frame-src": [...] replaces them
    for (const [k, v] of Object.entries(policy)) {
      if (k.startsWith("=")) d[k.slice(1)] = v;
      else d[k] = [...(d[k] || []).filter((s) => s !== "'none'"), ...v];
    }
    csp = Object.entries(d).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
    if (_cspCache.size > 50) _cspCache.clear();
    _cspCache.set(key, csp);
  }
  const res = new Response(html, response);
  return withHeaders(res, { "Content-Security-Policy": csp });
}
