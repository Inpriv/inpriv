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
