// ── Inpriv access log (shared) ───────────────────────────────────────────────
// One row per account-security event: when, which service, what happened,
// which account, and the network it came from. It exists to investigate
// account takeovers and abuse reports, and is described in the Privacy
// Policy (inpriv.xyz/privacy#log).
//
// Kept to the minimum (format v2, since October 2026):
//  - the network, not the address: IPv4 /24 or IPv6 /48 (clientNet). That is
//    not anonymous; with the account and time it can still point to a person.
//  - country and network operator (ASN), and the browser family ("Firefox ·
//    Linux"), never the full user agent;
//  - no recipient addresses, no Temp inboxes (Temp creation isn't logged).
// It never holds message contents, passwords, passphrases, keys, tokens or
// recovery codes.
//
// Rows are deleted after ACCESS_LOG_DAYS. Rows written before v2 (full IP,
// full user agent, recipients) keep their original 90-day deletion date; when
// the ACCESS_LOG_MINIMIZE secret is "1" they are also reduced to the v2 form
// right away. purgeAccessLog runs on the Temp Worker's hourly cron and on
// Mail's daily cron, so cleanup continues if one of them stops.
//
// The table lives in the inpriv-id database: ID binds it as DB, every other
// Worker as ID_DB. Logging is best-effort and never blocks a request.

import { clientNet, uaFamily } from "./security.js";

export const ACCESS_LOG_DAYS = 30;
export const LEGACY_LOG_DAYS = 90; // rows written before v2
export const SECURITY_EVENT_DAYS = 90; // ID's own security log (auth_events), shown to the user

let ready = false;
async function ensure(db) {
  if (ready) return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, service TEXT NOT NULL, event TEXT NOT NULL, account TEXT, detail TEXT, ip TEXT, country TEXT, asn INTEGER, ua TEXT)"
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_access_account ON access_log(account, at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_access_ip ON access_log(ip, at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_access_at ON access_log(at)"),
  ]);
  try { await db.prepare("ALTER TABLE access_log ADD COLUMN v INTEGER").run(); } catch { /* already there */ }
  ready = true;
}

// service: "id" | "mail"; account: username.
export async function logAccess(db, request, service, event, account) {
  if (!db) return;
  try {
    await ensure(db);
    const cf = (request && request.cf) || {};
    await db.prepare(
      "INSERT INTO access_log (at, service, event, account, detail, ip, country, asn, ua, v) VALUES (?,?,?,?,NULL,?,?,?,?,2)"
    ).bind(
      Date.now(), service, event,
      account ? String(account).toLowerCase().slice(0, 320) : null,
      request ? clientNet(request) : null,
      cf.country || null,
      Number.isFinite(cf.asn) ? cf.asn : null,
      request ? uaFamily(request.headers.get("User-Agent")) : null
    ).run();
  } catch { /* never block the request on logging */ }
}

// Reduce rows written before v2 to the v2 form (network, browser family, no
// recipient). Runs only after the operator confirms nothing is under a
// preservation request (secret ACCESS_LOG_MINIMIZE = "1").
async function minimizeLegacy(db) {
  const { results } = await db.prepare(
    "SELECT id, ip, ua FROM access_log WHERE v IS NULL LIMIT 500"
  ).all();
  if (!results || !results.length) return 0;
  await db.batch(results.map((r) => db.prepare(
    "UPDATE access_log SET ip = ?, ua = ?, detail = NULL, v = 2 WHERE id = ?"
  ).bind(
    r.ip ? clientNet(new Request("https://x/", { headers: { "CF-Connecting-IP": r.ip } })) : null,
    r.ua ? uaFamily(r.ua) : null,
    r.id
  )));
  return results.length;
}

// Retention for everything the inpriv-id database holds that expires:
// the access log, ID security events, rate-limit counters, and expired
// sign-in tickets, codes and sessions.
export async function purgeAccessLog(db, env = {}) {
  if (!db) return 0;
  const t = Date.now();
  let n = 0;
  const run = async (sql, ...args) => {
    try {
      const r = await db.prepare(sql).bind(...args).run();
      n += (r.meta && r.meta.changes) || 0;
    } catch { /* table missing on a fresh database: keep going */ }
  };
  try {
    await ensure(db);
    if (env.ACCESS_LOG_MINIMIZE === "1") n += await minimizeLegacy(db);
  } catch { /* keep going */ }
  await run("DELETE FROM access_log WHERE v = 2 AND at < ?", t - ACCESS_LOG_DAYS * 86_400_000);
  await run("DELETE FROM access_log WHERE v IS NULL AND at < ?", t - LEGACY_LOG_DAYS * 86_400_000);
  await run("DELETE FROM auth_events WHERE at < ?", t - SECURITY_EVENT_DAYS * 86_400_000);
  // counters written before they carried an expiry are dropped once
  try { await db.prepare("ALTER TABLE rl_counters ADD COLUMN exp INTEGER").run(); } catch { /* already there */ }
  await run("DELETE FROM rl_counters WHERE exp IS NULL OR exp < ?", t);
  await run("DELETE FROM sessions WHERE expires_at < ?", t);
  await run("DELETE FROM pending_2fa WHERE expires_at < ?", t);
  await run("DELETE FROM service_grants WHERE expires_at < ?", t - 3_600_000);
  await run("DELETE FROM id_init_tickets WHERE expires_at < ?", t - 3_600_000);
  await run("DELETE FROM email_codes WHERE expires_at < ?", t - 86_400_000);
  return n;
}
