// ── One URL per page ─────────────────────────────────────────────────────────
// http:// → https:// and www. → apex, with a permanent redirect, so search
// engines (and people) only ever see one address for each page. Only for the
// real inpriv.xyz hosts, so local `wrangler dev` on 127.0.0.1 is untouched.
// GET/HEAD get 301; anything else 308, which keeps the method and body.
export function canonicalRedirect(request) {
  const url = new URL(request.url);
  if (!/(^|\.)inpriv\.xyz$/.test(url.hostname)) return null;
  let moved = false;
  if (url.protocol === "http:") { url.protocol = "https:"; moved = true; }
  if (url.hostname.startsWith("www.")) { url.hostname = url.hostname.slice(4); moved = true; }
  if (!moved) return null;
  const safe = request.method === "GET" || request.method === "HEAD";
  return new Response(null, { status: safe ? 301 : 308, headers: { Location: url.toString() } });
}
