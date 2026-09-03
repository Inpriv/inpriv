// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Fake — disposable identities on fake.inpriv.xyz
//
// Every request requires a signed-in Inpriv ID account (SSO grant via id.js,
// or password + optional TOTP fallback identical to Host's login). Creating
// an identity:
//   1. generates a consistent fake persona (nick / first / last name)
//   2. mints a strong random password
//   3. registers a REAL zero-knowledge mailbox in Inpriv Mail's D1 (same
//      enrollment as mail.inpriv.xyz registration — client-side RSA-2048
//      keypair, PBKDF2-wrapped private key), so inbound Resend mail just
//      works (mail.inpriv.xyz serves it too, mail.inpriv.xyz is the UI)
//   4. seals the password with FAKE_ENC_KEY so the owner can re-reveal it
// The cron (every 15 min) hard-deletes expired mailboxes from Mail and marks
// the identity burned; /api/burn does it immediately on demand.
// ─────────────────────────────────────────────────────────────────────────────

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

const DOMAIN = "inpriv.xyz";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const PASS_ITERS = 300_000;
const PBKDF2_CAP = 100_000;
const MAX_IDENTITIES_PER_USER = 5;
const TOMBSTONE_KEEP_MS = 48 * 3600 * 1000; // purge metadata 48 h after death

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const now = () => Date.now();

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
const bad = (msg, status = 400) => json({ error: msg }, status);

function corsFor(req) {
  const o = req.headers.get("Origin") || "";
  if (o === `https://fake.inpriv.xyz` || /^https:\/\/[a-z0-9-]+\.inpriv\.xyz$/.test(o)) {
    return {
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
  }
  return {};
}

// ── password hashing (chained PBKDF2-SHA256, mirrors Inpriv ID / Mail) ──────
async function passHash(password, saltB64, iters = PASS_ITERS) {
  const rounds = Math.max(1, Math.ceil(iters / PBKDF2_CAP));
  let material = enc.encode(password);
  let bits;
  for (let r = 0; r < rounds; r++) {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: Math.min(iters - r * PBKDF2_CAP, PBKDF2_CAP) },
      key,
      256
    );
    material = new Uint8Array(bits);
  }
  return b64(bits);
}

function constantTimeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function rateLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(now() / windowMs);
  try {
    const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
    if (row && row.c >= limit) return false;
    await db.prepare("INSERT INTO rl_counters (k, bucket, c) VALUES (?,?,1) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
      .bind(key, bucket).run();
    return true;
  } catch {
    return true; // fail open
  }
}

// ── AES-256-GCM sealing of generated passwords (FAKE_ENC_KEY) ───────────────
let _aesKeyCache = null;
async function aesKey(env) {
  if (_aesKeyCache) return _aesKeyCache;
  let raw = enc.encode(env.FAKE_ENC_KEY || "");
  if (raw.length !== 32 && raw.length === 44) {
    try { raw = b64d(env.FAKE_ENC_KEY); } catch { /* fallthrough */ }
  }
  if (raw.length !== 32) throw new Error("FAKE_ENC_KEY must be 32 bytes (raw or base64)");
  _aesKeyCache = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return _aesKeyCache;
}

async function sealString(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plaintext));
  return JSON.stringify({ iv: b64(iv), ct: b64(ct) });
}

async function openString(env, envelopeJson) {
  try {
    const { iv, ct } = JSON.parse(envelopeJson);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, await aesKey(env), b64d(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// ── fake persona generator (self-consistent nick / first / last) ────────────
const FIRST = [
  "Ava","Liam","Noah","Emma","Mia","Ethan","Ivy","Leo","Nora","Owen",
  "Ruby","Finn","Iris","Hugo","Lena","Milo","Sofia","Arlo","Elsa","Theo",
  "Clara","Felix","June","Oscar","Ruth","Silas","Tessa","Vera","Wren","Ezra",
];
const LAST = [
  "Hayes","Brooks","Mercer","Holt","Vance","Cross","Whitfield","Sloane","Barrett","Keene",
  "Harlow","Nash","Reyes","Calloway","Finch","Marlowe","Quinn","Sterling","Voss","Winslow",
  "Aldridge","Bellamy","Crane","Dawson","Emerson","Gallagher","Hendrix","Ingles","Jarvis","Kessler",
];

// Pick one consistent persona: seeded by the random username so nick,
// first and last name always belong together for the identity's lifetime.
function makePersona() {
  const first = FIRST[crypto.getRandomValues(new Uint32Array(1))[0] % FIRST.length];
  const last = LAST[crypto.getRandomValues(new Uint32Array(1))[0] % LAST.length];
  // username: first.last + 3 digits (fits Mail's local-part regex)
  let suffix = "";
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900 + 100;
  suffix = String(n);
  const username = `${first.toLowerCase()}.${last.toLowerCase()}${suffix}`;
  const nick = `${first} ${last[0].toUpperCase()}.`; // e.g. "Emma H."
  return { username, nick, first, last };
}

function genPassword() {
  // 4 groups of 4 base58-ish chars: ~76 bits, no ambiguous glyphs
  const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < 16; i++) s += A[b[i] % A.length];
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16);
}

// ── auth ─────────────────────────────────────────────────────────────────────
function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function sessionCookie(token) {
  return `inpriv_fake=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; Secure; HttpOnly; SameSite=None; Partitioned`;
}
function clearCookie() {
  return `inpriv_fake=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`;
}
function cookieToken(req) {
  const ck = req.headers.get("Cookie") || "";
  const m = ck.match(/(?:^|;\s*)inpriv_fake=([^;]+)/);
  return m ? m[1] : null;
}

async function authUser(req, env) {
  const token = bearer(req) || cookieToken(req);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id sid, owner_id, username, nick, expires_at FROM sessions WHERE id = ?"
  ).bind(await sha256hex(token)).first();
  if (!row || row.expires_at < now()) return null;
  return row;
}

async function createSession(env, me, req) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await env.DB.prepare(
    "INSERT INTO sessions (id, owner_id, username, nick, created_at, last_used, expires_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(await sha256hex(token), me.id, me.username, me.nick || me.username, t, t, t + SESSION_TTL_MS).run();
  const ip = (req.headers.get("CF-Connecting-IP") || "x").split(".").slice(0, 2).join(".");
  return { token, ipKey: ip };
}

// ── SSO: redeem a one-time grant minted by id.js in the browser ─────────────
async function ssoLogin(request, env, cors, ctx) {
  const body = await request.json().catch(() => ({}));
  const grant = String(body.grant || "");
  const state = String(body.state || "");
  if (!grant) return bad("Missing sign-in grant", 400);
  const ip = (request.headers.get("CF-Connecting-IP") || "x").split(".").slice(0, 2).join(".");
  if (!(await rateLimit(env.DB, `fakesso:${ip}`, 20, 15 * 60_000)))
    return bad("Too many attempts — try again in 15 minutes", 429);
  if (!env.SERVICE_KEY) return bad("SSO not configured", 503);

  const r = await fetch("https://id.inpriv.xyz/api/grant/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Inpriv-Service": env.SERVICE_KEY },
    body: JSON.stringify({ grant, service: "fake" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) return bad((d && d.error) || "Sign-in grant rejected", 401);
  if (state && d.state && state !== d.state) return bad("Grant mismatch", 401);

  // A silent cross-site sign-in must never skip the second factor —
  // 2FA accounts use the password + code path instead.
  if (d.totp_enabled) return json({ totp_required: true, username: d.user.username }, 200, cors);

  const me = { id: d.user.id, username: d.user.username, nick: d.user.nick };
  const s = await createSession(env, me, request);
  ctx.waitUntil(syncIdConsent(env, me.id, me.username));
  return json({ token: s.token, user: pubUser(me) }, 200, cors, { "Set-Cookie": sessionCookie(s.token) });
}

// ── Password login fallback (mirrors Host): lets 2FA accounts sign in too ───
async function passLogin(request, env, cors, ctx) {
  const body = await request.json().catch(() => ({}));
  const input = String(body.user || "").trim().toLowerCase();
  const password = String(body.password || "");
  const totp = String(body.totp || "").trim();
  if (!input || !password) return bad("Enter your username and password", 400);

  const ip = (request.headers.get("CF-Connecting-IP") || "x").split(".").slice(0, 2).join(".");
  if (!(await rateLimit(env.DB, `fakelogin:${ip}`, 10, 15 * 60_000)))
    return bad("Too many attempts — try again in 15 minutes", 429);

  const local = input.split("@")[0];
  const idu = await env.ID_DB.prepare(
    "SELECT id, username, nick, pass_hash, pass_salt, pass_iters, totp_enabled FROM users WHERE username IN (?, ?) OR email IN (?, ?) OR recovery_email IN (?, ?) LIMIT 1"
  ).bind(local, input, local + "@" + DOMAIN, input, input, local + "@" + DOMAIN).first();

  // anti-enumeration: burn the same PBKDF2 work when the user doesn't exist
  let ok = false;
  if (idu) {
    const cand = await passHash(password, idu.pass_salt, idu.pass_iters);
    ok = constantTimeEq(cand, idu.pass_hash);
  } else {
    await passHash(password, b64(crypto.getRandomValues(new Uint8Array(16))), PASS_ITERS);
  }
  if (!idu || !ok) return bad("Invalid credentials", 401);

  if (idu.totp_enabled) {
    if (!totp) return json({ totp_required: true }, 200, cors);
    const v = await fetch("https://id.inpriv.xyz/api/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Inpriv-Service": env.SERVICE_KEY || "" },
      body: JSON.stringify({ username: idu.username, code: totp }),
    });
    let vd = null;
    try { vd = await v.json(); } catch {}
    if (!v.ok || !vd?.ok) return bad("Invalid 2FA code", 401);
  }

  const me = { id: idu.id, username: idu.username, nick: idu.nick };
  const s = await createSession(env, me, request);
  ctx.waitUntil(syncIdConsent(env, me.id, me.username));
  return json({ token: s.token, user: pubUser(me) }, 200, cors, { "Set-Cookie": sessionCookie(s.token) });
}

function pubUser(me) {
  return { id: me.id, username: me.username, nick: me.nick || me.username };
}

// ≤1 write/hour per account: keep the ID panel's "Connected services" truthful
async function syncIdConsent(env, uid, username) {
  try {
    const ts = now();
    const row = await env.ID_DB.prepare(
      "SELECT last_used FROM consents WHERE user_id = ? AND service = ?"
    ).bind(uid, "fake").first();
    if (row && row.last_used && ts - row.last_used < 3_600_000) return;
    await env.ID_DB.prepare(
      "INSERT INTO consents (user_id, service, granted_at, last_used) VALUES (?,?,?,?) " +
      "ON CONFLICT(user_id, service) DO UPDATE SET last_used = excluded.last_used"
    ).bind(uid, "fake", ts, ts).run();
  } catch { /* best-effort */ }
}

// ── identity creation: register a REAL mailbox inside Inpriv Mail ───────────
async function createIdentity(request, env, cors, me) {
  const body = await request.json().catch(() => ({}));
  const ttlMinutes = Number(body.ttl_minutes);

  const ALLOWED = { 60: 1, 360: 1, 1440: 1, 10080: 1, 43200: 1 };
  if (!ALLOWED[ttlMinutes]) return bad("Invalid lifetime — pick 1 h, 6 h, 24 h, 7 days or 30 days");

  if (!(await rateLimit(env.DB, `mk:${me.owner_id ?? me.id}`, 6, 3_600_000)))
    return bad("Too many identities created — try again later", 429);

  const active = await env.DB.prepare(
    "SELECT COUNT(*) c FROM identities WHERE owner_id = ? AND burned_at IS NULL AND expires_at > ?"
  ).bind(me.owner_id ?? me.id, now()).first();
  if ((active?.c || 0) >= MAX_IDENTITIES_PER_USER)
    return bad(`Identity limit reached (${MAX_IDENTITIES_PER_USER} active)`, 409);

  // Consistent persona, collision-checked against both databases.
  let persona = null, username = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    persona = makePersona();
    username = persona.username;
    const dupFake = await env.DB.prepare("SELECT 1 FROM identities WHERE username = ?").bind(username).first();
    if (dupFake) continue;
    const dupMail = await env.MAIL_DB.prepare(
      "SELECT 1 FROM users WHERE username = ? OR address = ?"
    ).bind(username, `${username}@${DOMAIN}`).first();
    if (dupMail) continue;
    const dupId = await env.ID_DB.prepare("SELECT 1 FROM users WHERE username = ? OR email = ?")
      .bind(username, `${username}@${DOMAIN}`).first();
    if (dupId) continue;
    break;
  }
  if (!persona) return bad("Could not allocate a unique identity — try again", 503);

  const password = genPassword();
  const t = now();
  const expiresAt = t + ttlMinutes * 60_000;

  // Seal the password so the owner can re-reveal it until the identity dies.
  const sealed = await sealString(env, password);

  const id = crypto.randomUUID();
  const addr = `${username}@${DOMAIN}`;

  // Register the mailbox in Mail's users table — exactly what Mail's own
  // registration does (auth verifier + client-generated zero-knowledge keys).
  // The client generated the RSA keypair in-browser and posts the envelope;
  // we persist it verbatim. Inbound Resend mail is delivered by Mail's
  // webhook because the address now exists in Mail's users table.
  const c = body.client; // { public_key, encrypted_private_key, priv_iv, priv_salt, priv_iter }
  if (!c || !c.public_key || !c.encrypted_private_key || !c.priv_iv || !c.priv_salt)
    return bad("Missing client crypto envelope");

  const authSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const authHash = await passHash(password, authSalt, parseInt(c.priv_iter, 10) || PASS_ITERS);

  try {
    await env.MAIL_DB.prepare(
      `INSERT INTO users (username, address, auth_hash, auth_salt, public_key,
                          encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at, last_login)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(username, addr, authHash, authSalt, String(c.public_key), String(c.encrypted_private_key),
           String(c.priv_iv), String(c.priv_salt), parseInt(c.priv_iter, 10) || PASS_ITERS, t, t).run();
  } catch (e) {
    return bad("Mailbox allocation failed — try again", 503);
  }

  await env.DB.prepare(
    `INSERT INTO identities (id, owner_id, username, address, nick, first_name, last_name,
                             pass_sealed, ttl_minutes, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, me.owner_id ?? me.id, username, addr, persona.nick, persona.first, persona.last,
         sealed, ttlMinutes, t, expiresAt).run();

  return json({
    identity: {
      id, username, address: addr, nick: persona.nick,
      first_name: persona.first, last_name: persona.last,
      password, // shown once in the response; sealed copy enables re-reveal
      ttl_minutes: ttlMinutes, created_at: t, expires_at: expiresAt,
    },
  }, 200, cors);
}

// ── hard-delete a mailbox everywhere (burn / expiry) ────────────────────────
async function destroyMailbox(env, username) {
  try {
    const u = await env.MAIL_DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
    if (u) {
      // messages reference users with ON DELETE CASCADE
      await env.MAIL_DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id).run();
    }
  } catch { /* next cron sweep retries via tombstone */ }
}

// ── router ──────────────────────────────────────────────────────────────────
let m; // regex scratch var

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsFor(request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const gate = await maintenanceGate("fake");
    if (gate.locked && path !== "/api/health") return maintenancePage("Inpriv Fake", gate.message);

    // static frontend for non-API GETs/HEADs
    if ((request.method === "GET" || request.method === "HEAD") && !path.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) return notFound(request, "Inpriv Fake");
      return res;
    }

    if (path === "/api/health") return json({ service: "inpriv-fake", status: "ok" });

    try {
      if (path === "/api/sso" && request.method === "POST") return await ssoLogin(request, env, cors, ctx);
      if (path === "/api/login" && request.method === "POST") return await passLogin(request, env, cors, ctx);

      if (path === "/api/logout" && request.method === "POST") {
        const token = bearer(request) || cookieToken(request);
        if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256hex(token)).run();
        return json({ ok: true }, 200, cors, { "Set-Cookie": clearCookie() });
      }

      // everything below requires a Fake session
      const me = await authUser(request, env);
      if (!me) return bad("unauthorized", 401);

      if (path === "/api/me" && request.method === "GET") {
        const active = await env.DB.prepare(
          "SELECT COUNT(*) c FROM identities WHERE owner_id = ? AND burned_at IS NULL AND expires_at > ?"
        ).bind(me.owner_id, now()).first();
        return json({ user: pubUser(me), active_count: active?.c || 0 }, 200, cors);
      }

      if (path === "/api/identities" && request.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT id, username, address, nick, first_name, last_name, ttl_minutes,
                  created_at, expires_at, burned_at
           FROM identities WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100`
        ).bind(me.owner_id).all();
        const t = now();
        return json({
          identities: (rows.results || []).map((r) => ({
            ...r,
            status: r.burned_at ? "burned" : r.expires_at <= t ? "expired" : "active",
          })),
        }, 200, cors);
      }

      if (path === "/api/identities" && request.method === "POST") {
        return await createIdentity(request, env, cors, me);
      }

      // re-reveal the password (sealed at rest with FAKE_ENC_KEY)
      if ((m = path.match(/^\/api\/identities\/([a-f0-9-]{36})\/password$/)) && request.method === "GET") {
        const row = await env.DB.prepare(
          "SELECT pass_sealed, expires_at, burned_at FROM identities WHERE id = ? AND owner_id = ?"
        ).bind(m[1], me.owner_id).first();
        if (!row) return bad("not found", 404);
        if (row.burned_at || row.expires_at <= now()) return bad("this identity is gone", 410);
        const password = await openString(env, row.pass_sealed);
        if (!password) return bad("decryption failure", 500);
        return json({ password }, 200, cors);
      }

      // manual burn: kill the mailbox now
      if ((m = path.match(/^\/api\/identities\/([a-f0-9-]{36})\/burn$/)) && request.method === "POST") {
        const row = await env.DB.prepare(
          "SELECT id, username, burned_at FROM identities WHERE id = ? AND owner_id = ?"
        ).bind(m[1], me.owner_id).first();
        if (!row) return bad("not found", 404);
        if (row.burned_at) return json({ ok: true, already: true }, 200, cors);
        await destroyMailbox(env, row.username);
        await env.DB.prepare("UPDATE identities SET burned_at = ? WHERE id = ?").bind(now(), row.id).run();
        return json({ ok: true }, 200, cors);
      }

      return bad("not found", 404);
    } catch (e) {
      return json({ error: "server error", detail: String((e && e.message) || e) }, 500);
    }
  },

  // every 15 minutes: sweep expired identities + tombstones + stale sessions
  async scheduled(_event, env) {
    const t = now();
    const expired = await env.DB.prepare(
      "SELECT id, username FROM identities WHERE burned_at IS NULL AND expires_at <= ?"
    ).bind(t).all();
    for (const r of expired.results || []) {
      await destroyMailbox(env, r.username);
      await env.DB.prepare("UPDATE identities SET burned_at = ? WHERE id = ?").bind(t, r.id).run();
    }
    // purge tombstones (metadata) 48 h after death. A row is purgable when
    // it is marked burned and that happened ≥48 h ago; the cron above marks
    // expired rows burned at sweep time, so this covers both paths.
    const keepFrom = t - TOMBSTONE_KEEP_MS;
    await env.DB.prepare("DELETE FROM identities WHERE burned_at IS NOT NULL AND burned_at < ?")
      .bind(keepFrom).run();
    // safety net: anything expired >48 h that slipped past the mark step
    await env.DB.prepare("DELETE FROM identities WHERE expires_at < ?")
      .bind(keepFrom).run();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM rl_counters WHERE bucket < ?").bind(Math.floor(t / 3_600_000) - 2),
    ]);
  },
};

