// ── Inpriv Admin — private control plane ────────────────────────────────────
// admin.inpriv.xyz — TOTP login (single user: saloyek), service kill-switches,
// global info banner, rate limiting, audit log. All state in MAINTENANCE KV.
//
// KV layout (MAINTENANCE):
//   global     → { locked, message, ts }   global kill + banner text
//   service:X  → { locked, message, ts }   per-service override
//   info       → { active, message, ts }   global info banner (no lock)
//   audit      → [ ...last 50 events ]
//   sess:<id>  → { user, exp }             sessions (7d TTL)
//   rl:<ip>    → { a, f, reset, block }    login rate limit
//
// Public read-only (used by tool workers, cached 15s on the edge):
//   GET /public/state → { global, services, ts }

// ── config ───────────────────────────────────────────────────────────────────
const SERVICES = [
  "landing",
  "temp",
  "mail",
  "burn",
  "qr",
  "stego",
  "brute",
  "compress",
  "trace",
  "hash",
  "keyring",
  "pay",
  "totp",
  "wipe",
  "censor",
  "account",
  "host",
  "fake",
  "share",
  "labs",
  "status",
];
const SERVICES_META = {
  landing:  { name: "Landing (inpriv.xyz)", url: "https://inpriv.xyz", icon: "home" },
  temp:     { name: "Temp Mail", url: "https://temp.inpriv.xyz", icon: "mark_email_unread" },
  mail:     { name: "Mail", url: "https://mail.inpriv.xyz", icon: "mail_lock" },
  burn:     { name: "Burn Messages", url: "https://burn.inpriv.xyz", icon: "local_fire_department" },
  qr:       { name: "Private QR", url: "https://qr.inpriv.xyz", icon: "qr_code_2" },
  stego:    { name: "Steganography", url: "https://stego.inpriv.xyz", icon: "visibility_off" },
  brute:    { name: "Brute / Password", url: "https://brute.inpriv.xyz", icon: "shield" },
  compress: { name: "Compress", url: "https://compress.inpriv.xyz", icon: "folder_zip" },
  trace:    { name: "Trace (IP · DNS · WebRTC)", url: "https://trace.inpriv.xyz", icon: "travel_explore" },
  hash:     { name: "Hash & Checksum", url: "https://hash.inpriv.xyz", icon: "tag" },
  keyring:  { name: "Keyring", url: "https://keyring.inpriv.xyz", icon: "vpn_key" },
  pay:      { name: "Crypto Pay", url: "https://pay.inpriv.xyz", icon: "payments" },
  totp:      { name: "TOTP / 2FA", url: "https://totp.inpriv.xyz", icon: "pin" },
  wipe:     { name: "Metadata Wipe", url: "https://wipe.inpriv.xyz", icon: "auto_fix_high" },
  censor:   { name: "Censor (screenshot redactor)", url: "https://censor.inpriv.xyz", icon: "privacy_tip" },
  account:  { name: "Inpriv ID (accounts)", url: "https://id.inpriv.xyz", icon: "badge" },
  host:     { name: "Host (static files)", url: "https://host.inpriv.xyz", icon: "cloud_upload" },
  fake:     { name: "Fake (disposable identities)", url: "https://fake.inpriv.xyz", icon: "theater_comedy" },
  share:    { name: "Share (P2P files)", url: "https://share.inpriv.xyz", icon: "swap_horiz" },
  labs:     { name: "Labs (experiments)", url: "https://labs.inpriv.xyz", icon: "science" },
  status:   { name: "Status (service health)", url: "https://status.inpriv.xyz", icon: "monitor_heart" },
};
const SESSION_TTL = 7 * 24 * 3600; // seconds
const COOKIE = "inpriv_admin";
const MAX_AUDIT = 50;
const PUB_CACHE_S = 2;

// ── router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    };
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (path === "/public/state") return await publicState(env, cors);
      if (path === "/api/login" && method === "POST") return await login(request, env, cors);

      const sess = await authed(request, env);
      if (!sess) return json({ error: "unauthorized" }, 401, cors);

      if (path === "/api/logout" && method === "POST") return await logout(request, env, cors);
      if (path === "/api/me") return json({ user: sess.user }, 200, cors);
      if (path === "/api/state") return await apiState(env, cors);
      if (path === "/api/global" && method === "POST") return await setGlobal(request, env, cors);
      if (path === "/api/info" && method === "POST") return await setInfo(request, env, cors);
      if (path === "/api/service" && method === "POST") return await setService(request, env, cors);
      if (path === "/api/audit") return await getAudit(env, cors);
      if (path === "/api/limit-requests" && method === "GET") return await listLimitRequests(env, cors);
      if (path === "/api/limit-request" && method === "POST") return await decideLimitRequest(request, env, cors);

      if (path === "/" || path === "/index.html") return dashboard();
      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500, cors);
    }
  },
};

// ── auth: TOTP + sessions ────────────────────────────────────────────────────
async function authed(request, env) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(/inpriv_admin=([A-Za-z0-9_-]{20,})/);
  if (!m) return null;
  const rec = await env.MAINTENANCE.get(`sess:${m[1]}`, { type: "json" });
  if (!rec) return null;
  if (rec.exp < Date.now() / 1000) {
    await env.MAINTENANCE.delete(`sess:${m[1]}`);
    return null;
  }
  return rec;
}

async function login(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  // rate limit: 10 attempts / 5 min / IP; 30 fails / 5 min → 15 min block
  const rlKey = `rl:${ip}`;
  const rl = (await env.MAINTENANCE.get(rlKey, { type: "json" })) || { a: 0, f: 0, reset: 0, block: 0 };
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
    await env.MAINTENANCE.put(rlKey, JSON.stringify(rl), { expirationTtl: 3600 });
    return json({ error: "too_many_attempts", retry_after: 900 }, 429, cors, { "Retry-After": "900" });
  }

  const body = await request.json().catch(() => ({}));
  const user = String(body.user || "").trim();
  const code = String(body.code || "").replace(/\s/g, "");

  let failReason = null;
  if (user !== "saloyek" || !/^\d{6}$/.test(code)) failReason = "invalid_credentials";
  else if (!(await verifyTOTP(code, env.TOTP_SECRET, now))) failReason = "invalid_code";

  if (failReason) {
    rl.f += 1;
    if (rl.f >= 30) rl.block = now + 900;
    await env.MAINTENANCE.put(rlKey, JSON.stringify(rl), { expirationTtl: 3600 });
    return json({ error: failReason }, 401, cors);
  }

  await env.MAINTENANCE.delete(rlKey); // clear on success
  const sid = crypto.randomUUID().replace(/-/g, "");
  const rec = { user, exp: now + SESSION_TTL };
  await env.MAINTENANCE.put(`sess:${sid}`, JSON.stringify(rec), { expirationTtl: SESSION_TTL });
  await audit(env, "login", { ip });
  return json({ ok: true, user }, 200, cors, {
    "Set-Cookie": `${COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`,
  });
}

async function logout(request, env, cors) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(/inpriv_admin=([A-Za-z0-9_-]{20,})/);
  if (m) await env.MAINTENANCE.delete(`sess:${m[1]}`);
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
  for (const off of [-1, 0, 1]) {
    const expect = await hotp(key, step + off);
    if (timingSafeEq(code, expect)) return true;
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
  const global = (await env.MAINTENANCE.get("global", { type: "json" })) || { locked: false, message: "" };
  const info = (await env.MAINTENANCE.get("info", { type: "json" })) || { active: false, message: "" };
  const services = {};
  for (const s of SERVICES) {
    services[s] = (await env.MAINTENANCE.get(`service:${s}`, { type: "json" })) || { locked: false, message: "" };
  }
  return { global, info, services };
}

async function publicState(env, cors) {
  const st = await getState(env);
  const body = JSON.stringify({ global: st.global, info: st.info, services: st.services, ts: Date.now() });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${PUB_CACHE_S}, stale-while-revalidate=30`,
      ...cors,
    },
  });
}

async function apiState(env, cors) {
  const st = await getState(env);
  const list = await getAuditRecords(env);
  return json({ ...st, audit: list, meta: SERVICES_META }, 200, cors);
}

async function setGlobal(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const locked = !!b.locked;
  const message = String(b.message || "").slice(0, 500);
  await env.MAINTENANCE.put("global", JSON.stringify({ locked, message, ts: Date.now() }));
  await audit(env, locked ? "global_lock" : "global_unlock", { message });
  return json({ ok: true }, 200, cors);
}

async function setInfo(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const active = !!b.active;
  const message = String(b.message || "").slice(0, 500);
  await env.MAINTENANCE.put("info", JSON.stringify({ active, message, ts: Date.now() }));
  await audit(env, active ? "info_on" : "info_off", { message });
  return json({ ok: true }, 200, cors);
}

async function setService(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const svc = String(b.service || "");
  if (!SERVICES.includes(svc)) return json({ error: "unknown_service" }, 400, cors);
  const locked = !!b.locked;
  const message = String(b.message || "").slice(0, 500);
  await env.MAINTENANCE.put(`service:${svc}`, JSON.stringify({ locked, message, ts: Date.now() }));
  await audit(env, locked ? `lock_${svc}` : `unlock_${svc}`, { message });
  return json({ ok: true }, 200, cors);
}

async function audit(env, action, extra = {}) {
  const list = await getAuditRecords(env);
  list.unshift({ ts: Date.now(), action, ...extra });
  await env.MAINTENANCE.put("audit", JSON.stringify(list.slice(0, MAX_AUDIT)));
}

async function getAuditRecords(env) {
  return (await env.MAINTENANCE.get("audit", { type: "json" })) || [];
}

async function getAudit(env, cors) {
  return json({ audit: await getAuditRecords(env) }, 200, cors);
}

// ── Host limit requests (review queue) ──────────────────────────────────────
// Requests land in HOST_DB.limit_requests from host.inpriv.xyz. Approving
// raises the account's storage quota (account_limits.quota_bytes) in one click.
// reason_enc stays sealed (RSA-OAEP to the operator's Mail key) — the worker
// never decrypts it; the dashboard decrypts client-side after Mail unlock.
async function listLimitRequests(env, cors) {
  const { results } = await env.HOST_DB.prepare(
    "SELECT id, user_id, contact, current_mb, requested_mb, reason_enc, created_at, status, decided_at, granted_mb FROM limit_requests ORDER BY (status = 'pending') DESC, id DESC LIMIT 100"
  ).all();
  const rows = results || [];
  // resolve requester usernames in one query (users live in Inpriv ID)
  const uids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const names = {};
  if (uids.length) {
    const qs = uids.map(() => "?").join(",");
    const { results: us } = await env.ID_DB.prepare(
      `SELECT id, username, nick FROM users WHERE id IN (${qs})`
    ).bind(...uids).all();
    for (const u of us || []) names[u.id] = u.nick || u.username || "unknown";
  }
  return json({
    requests: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      username: names[r.user_id] || null,
      contact: r.contact || "",
      current_mb: r.current_mb,
      requested_mb: r.requested_mb,
      reason_enc: r.reason_enc, // sealed — decrypted client-side only
      created_at: r.created_at,
      status: r.status,
      decided_at: r.decided_at,
      granted_mb: r.granted_mb,
    })),
  }, 200, cors);
}

async function decideLimitRequest(request, env, cors) {
  const b = await request.json().catch(() => ({}));
  const id = Number(b.id);
  const decision = String(b.decision || "");
  const grantGb = Number(b.grant_gb || 0);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "invalid_id" }, 400, cors);
  if (decision !== "approve" && decision !== "deny") return json({ error: "invalid_decision" }, 400, cors);
  if (decision === "approve" && (!Number.isInteger(grantGb) || grantGb < 1 || grantGb > 50))
    return json({ error: "grant must be 1–50 GB" }, 400, cors);

  const row = await env.HOST_DB.prepare("SELECT id, user_id, requested_mb, status FROM limit_requests WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not_found" }, 404, cors);
  if (row.status !== "pending") return json({ error: "already_decided" }, 409, cors);

  if (decision === "approve") {
    const grantedMb = grantGb * 1024;
    await env.HOST_DB.batch([
      env.HOST_DB.prepare(
        "INSERT INTO account_limits (user_id, quota_bytes) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET quota_bytes = excluded.quota_bytes"
      ).bind(row.user_id, grantedMb * 1024 * 1024),
      env.HOST_DB.prepare(
        "UPDATE limit_requests SET status = 'approved', decided_at = ?, granted_mb = ? WHERE id = ?"
      ).bind(Date.now(), grantedMb, id),
    ]);
    await audit(env, "limit_approve", { request_id: id, user_id: row.user_id, granted_gb: grantGb });
  } else {
    await env.HOST_DB.prepare(
      "UPDATE limit_requests SET status = 'denied', decided_at = ?, granted_mb = NULL WHERE id = ?"
    ).bind(Date.now(), id).run();
    await audit(env, "limit_deny", { request_id: id, user: row.user_id });
  }
  return json({ ok: true }, 200, cors);
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
