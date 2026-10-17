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
