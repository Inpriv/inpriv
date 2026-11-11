// The List-Unsubscribe header is attacker-controlled: a sender can put any URL
// in it. Everything the Worker fetches on a user's behalf goes through here.
//
// Returns a reason string when the URL must not be fetched, or null when it is
// acceptable. Only https, only a public-looking host, no credentials, no odd
// port, never our own sites.
export function unsubscribeUrlProblem(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "https:") return "only https links can be used";
  if (u.username || u.password) return "credentials are not allowed in the link";
  if (u.port && u.port !== "443") return "unexpected port";

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "invalid host";
  // a bare IPv4 or IPv6 literal is refused outright: unsubscribe endpoints are
  // named hosts, and this removes the whole numeric-encoding family
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "IP addresses are not allowed";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return "invalid host";
  const labels = host.split(".");
  if (labels.some((l) => /^\d+$/.test(l))) return "invalid host";
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return "invalid host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "local host";
  }
  if (host === "inpriv.xyz" || host.endsWith(".inpriv.xyz")) return "our own host";
  return null;
}

// The one unsubscribe target this message offers, parsed from the raw header at
// delivery time (before the body is encrypted). The endpoint later acts on this
// stored copy and ignores whatever the client sends, so a page cannot make the
// Worker fetch or mail an arbitrary destination.
//
// Shape: { kind: "web", href, oneClick } or { kind: "mailto", to, subject, body }
export function parseUnsubscribeTarget(header, postHeader) {
  if (typeof header !== "string" || !header || header.length > 8192) return null;
  const oneClick = /one-click/i.test(String(postHeader || ""));
  const parts = [...header.matchAll(/<([^<>]+)>/g)].map((m) => m[1].replace(/[\r\n\t ]/g, ""));

  for (const raw of parts) {
    if (!/^https:/i.test(raw)) continue;
    if (unsubscribeUrlProblem(raw)) continue;      // never store a target we may not fetch
    return { kind: "web", href: raw, oneClick };
  }
  for (const raw of parts) {
    if (!/^mailto:/i.test(raw)) continue;
    try {
      const u = new URL(raw);
      const to = decodeURIComponent(u.pathname).toLowerCase().trim();
      if (!/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(to) || to.length > 320) continue;
      return {
        kind: "mailto",
        to,
        subject: String(u.searchParams.get("subject") || "unsubscribe").slice(0, 200),
        body: String(u.searchParams.get("body") || "unsubscribe").slice(0, 2000),
      };
    } catch { /* not a usable mailto */ }
  }
  return null;
}
