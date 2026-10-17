// ── Inpriv access log (shared) ───────────────────────────────────────────────
// One row per account event: when, which service, what happened, which
// account, and the request's IP address, country, network (ASN) and browser.
// It exists to answer abuse reports and valid legal requests, and is
// described in the Privacy Policy (inpriv.xyz/privacy).
//
// It never holds message contents, passwords, keys or anything typed into a
// page. Rows are deleted after ACCESS_LOG_DAYS (purgeAccessLog runs on the
// Temp Worker's hourly cron).
//
// The table lives in the inpriv-id database: ID binds it as DB, every other
// Worker as ID_DB. Logging is best-effort and never blocks a request.

export const ACCESS_LOG_DAYS = 90;

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
  ready = true;
}

// service: "id" | "mail" | "temp"; account: username or full address.
export async function logAccess(db, request, service, event, account, detail = null) {
  if (!db) return;
  try {
    await ensure(db);
    const cf = (request && request.cf) || {};
    const h = (n) => (request && request.headers.get(n)) || null;
    await db.prepare(
      "INSERT INTO access_log (at, service, event, account, detail, ip, country, asn, ua) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(
      Date.now(), service, event,
      account ? String(account).toLowerCase().slice(0, 320) : null,
      detail ? String(detail).slice(0, 320) : null,
      h("CF-Connecting-IP"),
      cf.country || null,
      Number.isFinite(cf.asn) ? cf.asn : null,
      (h("User-Agent") || "").slice(0, 300) || null
    ).run();
  } catch { /* never block the request on logging */ }
}

export async function purgeAccessLog(db) {
  if (!db) return 0;
  try {
    await ensure(db);
    const r = await db.prepare("DELETE FROM access_log WHERE at < ?")
      .bind(Date.now() - ACCESS_LOG_DAYS * 86_400_000).run();
    return (r.meta && r.meta.changes) || 0;
  } catch {
    return 0;
  }
}
