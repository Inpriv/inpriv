// ── Inpriv Admin — private control plane ────────────────────────────────────
// admin.inpriv.xyz — TOTP login (one admin, username in the ADMIN_USER
// secret), service kill-switches,
// global info banner, rate limiting, audit log. All state in the inpriv-id
// D1 database (ID_DB), table admin_kv (k → JSON v, optional expiry):
//   state                → { global, info, services, audit }  (one read/write)
//   sess:<sha256(sid)>   → { user, exp }                      sessions (7d)
//   rl:<ip>              → { a, f, reset, block }             login rate limit
// It used to live in Google Drive files, which cost several slow Drive
// round-trips per login; state.json is imported from Drive once if D1 is
// still empty.
// Public read-only (used by tool workers, cached 2s on the edge):
//   GET /public/state → { global, info, services, ts }

import { kvGet as driveGet } from "../../../common/drive.js";

// ── config ───────────────────────────────────────────────────────────────────
// The services that check this panel's kill-switches (common/gate.js ids).
const SERVICES = ["landing", "mail", "temp", "account"];
const SERVICES_META = {
  landing: { name: "Landing (inpriv.xyz)", url: "https://inpriv.xyz", icon: "home" },
  mail:    { name: "Mail", url: "https://mail.inpriv.xyz", icon: "mail_lock" },
  temp:    { name: "Temp Mail", url: "https://temp.inpriv.xyz", icon: "mark_email_unread" },
  account: { name: "Inpriv ID (accounts)", url: "https://id.inpriv.xyz", icon: "badge" },
};
const SESSION_TTL = 7 * 24 * 3600; // seconds
const COOKIE = "inpriv_admin";
const MAX_AUDIT = 50;
const PUB_CACHE_S = 2;

// ── router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    };
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // keep background promises alive past the response (a bare floating
    // promise is cancelled once fetch returns — that is what dropped the
    // session write and logged the user out right after login)
    const waitUntil = (p) => {
      try { ctx.waitUntil(Promise.resolve(p).catch(() => {})); } catch { Promise.resolve(p).catch(() => {}); }
    };

    try {
      if (path === "/public/state") return await publicState(env, cors, request);
      if (path === "/api/login" && method === "POST") return await login(request, env, cors, waitUntil);

      // expired-row sweep trigger (shared secret, for scripts)
      if (path === "/api/sweep" && method === "POST") {
        const h = request.headers.get("X-Sweep-Secret") || "";
        if (!env.SWEEP_SECRET || h !== env.SWEEP_SECRET) return json({ error: "unauthorized" }, 401, cors);
        return json({ ok: true, admin: { removed: await sweepOwn(env) } }, 200, cors);
      }

      const sess = await authed(request, env);
      if (!sess) return json({ error: "unauthorized" }, 401, cors);

      // lazy own-state sweep (5% of authed requests)
      if (Math.random() < 0.05) waitUntil(sweepOwn(env));

      if (path === "/api/logout" && method === "POST") return await logout(request, env, cors);
      if (path === "/api/me") return json({ user: sess.user }, 200, cors);
      if (path === "/api/state") return await apiState(env, cors, sess);
      if (path === "/api/global" && method === "POST") return await setGlobal(request, env, cors);
      if (path === "/api/info" && method === "POST") return await setInfo(request, env, cors);
      if (path === "/api/service" && method === "POST") return await setService(request, env, cors);
      if (path === "/api/audit") return await getAudit(env, cors);
      if (path === "/api/records" && method === "GET") return await records(url, env, cors);
      if (path.startsWith("/api/team")) return await team(request, url, env, cors);
      if (path === "/api/temp" || path.startsWith("/api/temp/")) return await temp(request, url, env, cors);

      if (path === "/" || path === "/index.html") return dashboard();
      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500, cors);
    }
  },

  // No cron slot on the Free plan — the sweep runs lazily on authed requests.
  // The scheduled handler stays for when a slot frees up.
  async scheduled(controller, env, ctx) {
    await sweepOwn(env);
  },
};

// Removes expired sessions and rate-limit rows. Module-level so fetch()
// can call it (it used to be a method that fetch referenced by bare name).
async function sweepOwn(env) {
  try {
    await ensureKv(env);
    const r = await env.ID_DB.prepare("DELETE FROM admin_kv WHERE exp IS NOT NULL AND exp < ?")
      .bind(Math.floor(Date.now() / 1000)).run();
    const removed = (r.meta && r.meta.changes) || 0;
    console.log(`admin sweep: removed ${removed} stale rows`);
    return removed;
  } catch (e) {
    console.log("admin sweep failed:", String(e?.message || e));
    return 0;
  }
}

// ── storage: admin_kv in D1 ──────────────────────────────────────────────────
let _kvReady = false;
async function ensureKv(env) {
  if (_kvReady) return;
  await env.ID_DB.prepare(
    "CREATE TABLE IF NOT EXISTS admin_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)"
  ).run();
  _kvReady = true;
}
async function kvGet(env, k) {
  await ensureKv(env);
  const row = await env.ID_DB.prepare("SELECT v, exp FROM admin_kv WHERE k = ?").bind(k).first();
  if (!row || (row.exp && row.exp < Date.now() / 1000)) return null;
  return row.v;
}
async function kvPut(env, k, v, exp = null) {
  await ensureKv(env);
  await env.ID_DB.prepare(
    "INSERT INTO admin_kv (k, v, exp) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp"
  ).bind(k, v, exp == null ? null : Math.ceil(exp)).run();
}
async function kvDelete(env, k) {
  await ensureKv(env);
  await env.ID_DB.prepare("DELETE FROM admin_kv WHERE k = ?").bind(k).run();
}
async function sidKey(sid) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sid));
  return "sess:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── kill-switch state (one row) ──────────────────────────────────────────────
// Cached in isolate memory for a few seconds — /public/state is hit by every
// tool worker; writes from this isolate update the cache at once.
const STATE_CACHE_TTL = 3_000;
let _stateCache = { data: null, until: 0 };

function defaultState() {
  return {
    global: { locked: false, message: "", ts: 0 },
    info: { active: false, message: "", ts: 0 },
    services: {},
    audit: [],
  };
}

async function readState(env) {
  const now = Date.now();
  if (_stateCache.data && _stateCache.until > now) return _stateCache.data;
  let raw = await kvGet(env, "state");
  if (raw == null) {
    // first run on D1: bring the Drive state over once (kill-switches,
    // notice, audit) so nothing that is switched on gets lost
    // A Drive error leaves D1 empty so the import is retried; "no file"
    // stores the default so Drive isn't asked again.
    let imported = false;
    try {
      raw = env.DRIVE_OAUTH ? await driveGet(env, "state.json") : null;
      imported = true;
    } catch { raw = null; }
    if (raw || imported) await kvPut(env, "state", raw || JSON.stringify(defaultState()));
  }
  let st;
  if (raw) {
    try { st = JSON.parse(raw); } catch { st = defaultState(); }
  } else st = defaultState();
  st = { ...defaultState(), ...st };
  _stateCache = { data: st, until: now + STATE_CACHE_TTL };
  return st;
}

async function writeState(env, st) {
  await kvPut(env, "state", JSON.stringify(st));
  _stateCache = { data: st, until: Date.now() + STATE_CACHE_TTL };
}

// ── auth: TOTP + sessions ────────────────────────────────────────────────────
// Session cache (per isolate, 60 s) — the dashboard polls authed endpoints.
const _sessCache = new Map(); // sid -> rec | null
const SESS_CACHE_TTL = 60_000;

async function authed(request, env) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(/inpriv_admin=([A-Za-z0-9_-]{20,})/);
  if (!m) return null;
  const sid = m[1];
  const now = Date.now();
  const hit = _sessCache.get(sid);
  if (hit && hit.until > now) return hit.rec;
  const recRaw = await kvGet(env, await sidKey(sid));
  if (!recRaw) return null; // misses aren't cached: a login on another isolate
                            // must work straight away
  let rec;
  try { rec = JSON.parse(recRaw); } catch { return null; }
  if (rec.exp < now / 1000) {
    _sessCache.set(sid, { rec: null, until: now + SESS_CACHE_TTL }); // expired: safe to cache
    sidKey(sid).then((k) => kvDelete(env, k)).catch(() => {});
    return null;
  }
  _sessCache.set(sid, { rec, until: now + SESS_CACHE_TTL });
  return rec;
}

async function login(request, env, cors, waitUntil) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  // rate limit: 10 attempts / 5 min / IP; 30 fails / 5 min → 15 min block
  const rlName = `rl:${ip}`;
  const rlRaw = await kvGet(env, rlName);
  let rl = null;
  try { rl = rlRaw ? JSON.parse(rlRaw) : null; } catch { rl = null; }
  if (!rl) rl = { a: 0, f: 0, reset: 0, block: 0 };
  const now = Date.now() / 1000;
  if (rl.block > now) {
    return json({ error: "too_many_attempts", retry_after: Math.ceil(rl.block - now) }, 429, cors, {
      "Retry-After": String(Math.ceil(rl.block - now)),
    });
  }
  if (rl.reset < now) {
    rl.a = 0;
    rl.f = 0;
    rl.reset = now + 300;
  }
  rl.a += 1;
  if (rl.a > 10) {
    rl.block = now + 900;
    await kvPut(env, rlName, JSON.stringify(rl), rl.block + 3600);
    return json({ error: "too_many_attempts", retry_after: 900 }, 429, cors, { "Retry-After": "900" });
  }

  const body = await request.json().catch(() => ({}));
  const user = String(body.user || "").trim();
  const code = String(body.code || "").replace(/\s/g, "");

  let failReason = null;
  if (!env.ADMIN_USER || user !== env.ADMIN_USER || !/^\d{6}$/.test(code)) failReason = "invalid_credentials";
  else if (!(await verifyTOTP(code, env.TOTP_SECRET, now))) failReason = "invalid_code";

  if (failReason) {
    rl.f += 1;
    if (rl.f >= 30) rl.block = now + 900;
    // persist the failure counter — queued so the response stays fast
    waitUntil(kvPut(env, rlName, JSON.stringify(rl), Math.max(rl.reset, rl.block) + 3600));
    return json({ error: failReason }, 401, cors);
  }

  waitUntil(kvDelete(env, rlName)); // clear the counter on success
  const sid = crypto.randomUUID().replace(/-/g, "");
  const rec = { user, exp: now + SESSION_TTL };
  // The session must exist before the cookie reaches the browser: the client
  // calls /api/state right away.
  try {
    await kvPut(env, await sidKey(sid), JSON.stringify(rec), rec.exp);
  } catch (e) {
    return json({ error: "session_write_failed" }, 503, cors);
  }
  // one audit record → one state read+write; queued so the login response
  // doesn't wait for it
  waitUntil(audit(env, "login", { ip }));
  return json({ ok: true, user }, 200, cors, {
    "Set-Cookie": `${COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`,
  });
}

async function logout(request, env, cors) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(/inpriv_admin=([A-Za-z0-9_-]{20,})/);
  if (m) {
    await kvDelete(env, await sidKey(m[1]));
    _sessCache.delete(m[1]);
  }
  return json({ ok: true }, 200, cors, {
    "Set-Cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  });
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, ±1 step) ────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s) {
  s = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function verifyTOTP(code, b32Secret, nowS) {
  if (!b32Secret) return false;
  const key = base32Decode(b32Secret);
  if (!key.length) return false;
  const step = Math.floor(nowS / 30);
  // check the current step FIRST — it matches ~97% of real logins, so the
  // usual path costs one HMAC instead of three
  if (timingSafeEq(code, await hotp(key, step))) return true;
  for (const off of [-1, 1]) {
    if (timingSafeEq(code, await hotp(key, step + off))) return true;
  }
  return false;
}

async function hotp(key, counter) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 2 ** 32));
  dv.setUint32(4, counter >>> 0);
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf));
  const o = mac[19] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1e6).padStart(6, "0");
}

function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── kill-switch state ────────────────────────────────────────────────────────
async function getState(env) {
  const st = await readState(env);
  const services = {};
  for (const s of SERVICES) {
    services[s] = st.services[s] || { locked: false, message: "" };
  }
  return { global: st.global, info: st.info, services };
}

async function publicState(env, cors, request) {
  // Edge-cache the public state briefly: gate checks from every tool worker
  // hit this endpoint.
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/public/state", request);
  let res = await cache.match(cacheKey);
  if (!res) {
    const st = await getState(env);
    const body = JSON.stringify({ global: st.global, info: st.info, services: st.services, ts: Date.now() });
    res = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${PUB_CACHE_S}, stale-while-revalidate=30`,
        ...cors,
      },
    });
    res = res.clone();
    await cache.put(cacheKey, res);
    // rebuild from the cached representation so the returned object is independent
    res = await cache.match(cacheKey);
  }
  return res;
}

async function apiState(env, cors, sess = null) {
  const st = await getState(env);
  const list = await getAuditRecords(env);
  const payload = { ...st, audit: list, meta: SERVICES_META };
  if (sess) payload.user = sess.user;
  return json(payload, 200, cors);
}

async function setGlobal(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const locked = !!b.locked;
  const message = String(b.message || "").slice(0, 500);
  const st = await readState(env);
  st.global = { locked, message, ts: Date.now() };
  await writeState(env, st);
  await audit(env, locked ? "global_lock" : "global_unlock", { message });
  return json({ ok: true }, 200, cors);
}

async function setInfo(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const active = !!b.active;
  const message = String(b.message || "").slice(0, 500);
  const st = await readState(env);
  st.info = { active, message, ts: Date.now() };
  await writeState(env, st);
  await audit(env, active ? "info_on" : "info_off", { message });
  return json({ ok: true }, 200, cors);
}

async function setService(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const svc = String(b.service || "");
  if (!SERVICES.includes(svc)) return json({ error: "unknown_service" }, 400, cors);
  const locked = !!b.locked;
  const message = String(b.message || "").slice(0, 500);
  const st = await readState(env);
  st.services[svc] = { locked, message, ts: Date.now() };
  await writeState(env, st);
  await audit(env, locked ? `lock_${svc}` : `unlock_${svc}`, { message });
  return json({ ok: true }, 200, cors);
}

async function audit(env, action, extra = {}) {
  const st = await readState(env);
  st.audit = st.audit || [];
  st.audit.unshift({ ts: Date.now(), action, ...extra });
  st.audit = st.audit.slice(0, MAX_AUDIT);
  await writeState(env, st);
}

async function getAuditRecords(env) {
  const st = await readState(env);
  return st.audit || [];
}

async function getAudit(env, cors) {
  return json({ audit: await getAuditRecords(env) }, 200, cors);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function json(obj, status, cors, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors, ...extraHeaders },
  });
}

function dashboard() {
  return new Response(null, { status: 302, headers: { Location: "/index.html" } });
}

// exported for tests
export { verifyTOTP, hotp, base32Decode, timingSafeEq };

// ── records: what Inpriv holds about an account, address or IP ───────────────
// For abuse reports and valid legal requests. Read-only, and every lookup
// is written to the audit log. Message bodies in Mail are end-to-end
// encrypted and are never returned (the server can't read them); Temp
// inboxes are listed by metadata only.
const RECORD_LIMIT = 500;
const NEVER_HELD = [
  "Mail message bodies between Inpriv users (end-to-end encrypted in the browser)",
  "Stored Mail message bodies from outside senders (encrypted to the user's key when received)",
  "Passwords (only salted hashes), private keys and password-derived keys",
  "Anything typed into a page that wasn't submitted",
  "Access-log rows older than 90 days",
];

async function rows(db, sql, ...args) {
  if (!db) return [];
  try { return (await db.prepare(sql).bind(...args).all()).results || []; } catch { return []; }
}
async function row(db, sql, ...args) {
  if (!db) return null;
  try { return await db.prepare(sql).bind(...args).first(); } catch { return null; }
}

async function records(url, env, cors) {
  let q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  if (!q || q.length > 320) return json({ error: "enter a username, an address or an IP" }, 400, cors);
  const isIp = /^[0-9.]+$/.test(q) || (q.includes(":") && /^[0-9a-f:]+$/.test(q));
  const local = q.endsWith("@inpriv.xyz") ? q.slice(0, -"@inpriv.xyz".length) : (q.includes("@") ? null : q);
  const address = local ? `${local}@inpriv.xyz` : q;
  const out = { query: q, generated_at: new Date().toISOString(), never_held: NEVER_HELD };

  if (isIp) {
    out.access_log = await rows(env.ID_DB,
      "SELECT at, service, event, account, detail, ip, country, asn, ua FROM access_log WHERE ip = ? ORDER BY at DESC LIMIT ?", q, RECORD_LIMIT * 2);
    out.accounts_seen = [...new Set(out.access_log.map((r) => r.account).filter(Boolean))];
  } else {
    const acc = local && await row(env.ID_DB,
      "SELECT id, username, email, recovery_email, recovery_email_verified, nick, totp_enabled, created_at, last_login FROM users WHERE username = ?", local);
    if (acc) {
      out.account = acc;
      out.id_sessions = await rows(env.ID_DB,
        "SELECT label, ip_prefix, created_at, last_used, expires_at FROM sessions WHERE user_id = ? ORDER BY last_used DESC LIMIT 50", acc.id);
      out.id_events = await rows(env.ID_DB,
        "SELECT kind, ip_prefix, ula, at FROM auth_events WHERE user_id = ? ORDER BY at DESC LIMIT ?", acc.id, RECORD_LIMIT);
    }
    const mb = local && await row(env.MAIL_DB,
      "SELECT id, username, address, created_at, last_login FROM users WHERE username = ?", local);
    if (mb) {
      out.mailbox = mb;
      out.mailbox.quick_unlock_devices = (await row(env.MAIL_DB, "SELECT COUNT(*) AS n FROM device_keys WHERE user_id = ?", mb.id) || {}).n || 0;
      out.mail_sessions = await rows(env.MAIL_DB,
        "SELECT created_at, expires_at, ua FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", mb.id);
      // metadata only: the bodies are ciphertext the server can't open
      out.mail_messages = await rows(env.MAIL_DB,
        "SELECT direction, peer_address, subject, created_at, length(ciphertext) AS encrypted_size FROM messages WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?", mb.id, RECORD_LIMIT);
    }
    out.temp_inboxes = await rows(env.TEMP_DB,
      "SELECT address, created_at, expires_at FROM mailboxes WHERE address = ?", address);
    out.temp_messages = await rows(env.TEMP_DB,
      "SELECT from_addr, to_addr, subject, size, received_at FROM messages WHERE mailbox = ? ORDER BY received_at DESC LIMIT ?", address, RECORD_LIMIT);
    out.access_log = await rows(env.ID_DB,
      "SELECT at, service, event, account, detail, ip, country, asn, ua FROM access_log WHERE account = ? OR account = ? ORDER BY at DESC LIMIT ?",
      local || q, address, RECORD_LIMIT * 2);
  }
  await audit(env, "records_lookup", { message: q });
  return json(out, 200, cors);
}

// ── team mailboxes (support@, abuse@, dmca@ …) ───────────────────────────────
// Stored and sent by Mail (TeamMail entrypoint); admin only relays, behind
// its own session check. Sends and deletions go to the audit log.
async function team(request, url, env, cors) {
  if (!env.TEAM) return json({ error: "team mailboxes aren't connected" }, 503, cors);
  const path = url.pathname, method = request.method;
  try {
    if (path === "/api/team" && method === "GET") return json({ mailboxes: await env.TEAM.summary() }, 200, cors);
    if (path === "/api/team/list" && method === "GET") {
      return json({ messages: await env.TEAM.list(String(url.searchParams.get("box") || ""), 200) }, 200, cors);
    }
    if (path === "/api/team/msg" && method === "GET") {
      const m = await env.TEAM.get(Number(url.searchParams.get("id")));
      return m ? json({ message: m }, 200, cors) : json({ error: "not found" }, 404, cors);
    }
    const b = method === "POST" ? await request.json().catch(() => ({})) : {};
    if (path === "/api/team/send" && method === "POST") {
      const r = await env.TEAM.send({ mailbox: b.mailbox, to: b.to, subject: b.subject, text: b.text });
      await audit(env, "team_send", { message: `${b.mailbox}@ → ${String(b.to || "").slice(0, 120)}` });
      return json(r, 200, cors);
    }
    if (path === "/api/team/read" && method === "POST") return json({ ok: await env.TEAM.setRead(Number(b.id), !!b.read) }, 200, cors);
    if (path === "/api/team/delete" && method === "POST") {
      await env.TEAM.remove(Number(b.id));
      await audit(env, "team_delete", { message: `message ${Number(b.id)}` });
      return json({ ok: true }, 200, cors);
    }
    return json({ error: "not found" }, 404, cors);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 400, cors);
  }
}

// ── Temp inboxes ─────────────────────────────────────────────────────────────
// Live overview of temp.inpriv.xyz: active inboxes and message metadata (no
// bodies, same as Records). Deleting an inbox removes it and its messages
// right away; the Temp page then gets a 401 and starts a new inbox. Opening
// and deleting an inbox go to the audit log.
const TEMP_LIST_LIMIT = 200;
const likeEsc = (v) => v.replace(/[\\%_]/g, (c) => "\\" + c);

async function temp(request, url, env, cors) {
  if (!env.TEMP_DB) return json({ error: "Temp isn't connected" }, 503, cors);
  const path = url.pathname, method = request.method, now = Date.now(), day = now - 86400000;

  if (path === "/api/temp" && method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 120);
    const n = async (db, sql, ...a) => ((await row(db, sql, ...a)) || {}).n || 0;
    const [active, messages, received, created] = await Promise.all([
      n(env.TEMP_DB, "SELECT COUNT(*) AS n FROM mailboxes WHERE expires_at > ?", now),
      n(env.TEMP_DB, "SELECT COUNT(*) AS n FROM messages"),
      n(env.TEMP_DB, "SELECT COUNT(*) AS n FROM messages WHERE received_at > ?", day),
      n(env.ID_DB, "SELECT COUNT(*) AS n FROM access_log WHERE service = 'temp' AND event = 'inbox_created' AND at > ?", day),
    ]);
    const inboxes = await rows(env.TEMP_DB,
      `SELECT m.address, m.created_at, m.expires_at, COUNT(x.id) AS messages, MAX(x.received_at) AS last_at
         FROM mailboxes m LEFT JOIN messages x ON x.mailbox = m.address
        WHERE m.expires_at > ? AND m.address LIKE ? ESCAPE '\\'
        GROUP BY m.address ORDER BY m.created_at DESC LIMIT ?`,
      now, `%${likeEsc(q)}%`, TEMP_LIST_LIMIT);
    return json({ stats: { active, messages, received_24h: received, created_24h: created }, inboxes, limit: TEMP_LIST_LIMIT }, 200, cors);
  }

  if (path === "/api/temp/inbox" && method === "GET") {
    const address = String(url.searchParams.get("address") || "").trim().toLowerCase();
    const inbox = await row(env.TEMP_DB, "SELECT address, created_at, expires_at FROM mailboxes WHERE address = ?", address);
    if (!inbox) return json({ error: "This inbox is gone (expired or deleted)" }, 404, cors);
    const [messages, created_from] = await Promise.all([
      rows(env.TEMP_DB,
        "SELECT received_at, from_addr, from_name, subject, att_count, size FROM messages WHERE mailbox = ? ORDER BY received_at DESC LIMIT ?",
        address, RECORD_LIMIT),
      row(env.ID_DB,
        "SELECT ip, country, asn, ua FROM access_log WHERE service = 'temp' AND event = 'inbox_created' AND account = ? ORDER BY at DESC LIMIT 1",
        address),
    ]);
    await audit(env, "temp_view", { message: address });
    return json({ inbox, messages, created_from }, 200, cors);
  }

  if (path === "/api/temp/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const address = String(b.address || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+@inpriv\.xyz$/.test(address)) return json({ error: "not a Temp address" }, 400, cors);
    const out = await env.TEMP_DB.batch([
      env.TEMP_DB.prepare("DELETE FROM messages WHERE mailbox = ?").bind(address),
      env.TEMP_DB.prepare("DELETE FROM sends WHERE mailbox = ?").bind(address),
      env.TEMP_DB.prepare("DELETE FROM mailboxes WHERE address = ?").bind(address),
    ]);
    const removed = out[2]?.meta?.changes || 0;
    if (!removed) return json({ error: "This inbox is gone (expired or deleted)" }, 404, cors);
    await audit(env, "temp_delete", { message: `${address} (${out[0]?.meta?.changes || 0} messages)` });
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "not found" }, 404, cors);
}
