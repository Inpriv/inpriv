// Inpriv Mail — zero-knowledge internal mail (mail.inpriv.xyz)
// Frontend contract (public/index.html):
//   POST /api/v1/register  {username, password, password_confirm, public_key,
//                           encrypted_private_key, priv_iv, priv_salt, priv_iter}
//        → {token, user:{id, username, email, public_key,
//                        encrypted_private_key, priv_iv, priv_salt, priv_iter}}
//   POST /api/v1/login     {username, password}
//        → {token, user:{...same fields}}   (needs priv_* to unlock offline)
//   GET  /api/v1/me        → {user fields incl. priv_*}
//   GET  /api/v1/messages  → {items:[{id, direction, peer_address, peer_label,
//        subject, is_read, created_at}]}   (list: metadata only)
//   GET  /api/v1/messages/:id → message + encrypted_aes_key, iv, ciphertext, auth_tag
//   POST /api/v1/messages/send {to_username, subject, encrypted_aes_key, iv,
//        ciphertext, auth_tag} → {ok, id}  (server copies envelope to both parties)
//   GET  /api/v1/users/:username/pubkey → {public_key}
//   POST /api/v1/logout
//
// The server never sees plaintext: RSA-OAEP hybrid envelopes from the browser.
// Passwords: PBKDF2-SHA256, 3×100 000 chained (CF caps single deriveBits at 100k).

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

const DOMAIN = "inpriv.xyz";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const PASS_ITERS = 300_000;
const PBKDF2_CAP = 100_000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const now = () => Date.now();

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
const bad = (msg, status = 400) => json({ detail: { message: msg } }, status); // frontend reads detail.message

// ── password hashing (chained PBKDF2, same scheme as Inpriv ID) ─────────────
async function passHash(password, saltB64, iters = PASS_ITERS) {
  const rounds = Math.max(1, Math.ceil(iters / PBKDF2_CAP));
  let material = enc.encode(password);
  let bits = new ArrayBuffer(0);
  for (let r = 0; r < rounds; r++) {
    const take = Math.min(iters - r * PBKDF2_CAP, PBKDF2_CAP);
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: take },
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

// ── rate limit ──────────────────────────────────────────────────────────────
async function rateLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(now() / windowMs);
  const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
  if (row && row.c >= limit) return false;
  await db.prepare("INSERT INTO rl_counters (k, bucket, c) VALUES (?,?,1) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
    .bind(key, bucket).run();
  return true;
}

function ipKey(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return parts.slice(0, 2).join(".");
  return ip.slice(0, 12);
}

// ── sessions ────────────────────────────────────────────────────────────────
function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.address,
    public_key: u.public_key,
    encrypted_private_key: u.encrypted_private_key,
    priv_iv: u.priv_iv,
    priv_salt: u.priv_salt,
    priv_iter: u.priv_iter,
    created_at: u.created_at,
  };
}

async function authUser(req, env) {
  const token = bearer(req);
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(id).first();
  if (!row || row.expires_at < now()) return null;
  return row;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    // Static frontend (and anything else that is not the API) → assets.
    if (!path.startsWith("/api/")) {
      const gate = await maintenanceGate("mail");
      if (gate.locked) return maintenancePage("Inpriv Mail", gate.message);
      return env.ASSETS.fetch(request);
    }

    const gate = await maintenanceGate("mail");
    if (gate.locked && path !== "/api/v1/health") return maintenancePage("Inpriv Mail", gate.message);

    if (path === "/api/v1/health") return json({ status: "ok" });

    try {
      // ═══ AUTH ═══
      if (path === "/api/v1/available" && request.method === "GET") {
        const local = (url.searchParams.get("username") || "").toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(local)) return json({ available: false });
        const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(local).first();
        return json({ available: !exists });
      }

      if (path === "/api/v1/register" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `reg:${ipKey(request)}`, 5, 3_600_000)))
          return bad("too many registrations — try later", 429);
        const body = await request.json();
        const username = String(body.username || "").toLowerCase();
        const password = String(body.password || "");
        const passwordConfirm = String(body.password_confirm || "");
        if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(username)) return bad("invalid username (2-32: a-z 0-9 . _ -)");
        if (password.length < 10) return bad("password too short (min 10)");
        if (password !== passwordConfirm) return bad("passwords do not match");
        const pubkey = String(body.public_key || "");
        const epk = String(body.encrypted_private_key || "");
        if (!pubkey || !epk || !body.priv_iv || !body.priv_salt || !body.priv_iter)
          return bad("missing crypto envelope");

        const address = username + "@" + DOMAIN;
        const dup = await env.DB.prepare("SELECT 1 FROM users WHERE username = ? OR address = ?").bind(username, address).first();
        if (dup) return bad("username taken", 409);

        const authSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const authHash = await passHash(password, authSalt);
        const res = await env.DB.prepare(
          `INSERT INTO users (username, address, auth_hash, auth_salt, public_key,
                              encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          username, address, authHash, authSalt, String(pubkey),
          epk, String(body.priv_iv), String(body.priv_salt), parseInt(body.priv_iter, 10) || 0, now()
        ).run();
        const uid = res.meta?.last_row_id;

        const token = b64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare(
          "INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)"
        ).bind(await sha256hex(token), uid, now(), now() + SESSION_TTL_MS, ua(request)).run();

        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
        return json({ token, user: publicUser(user) });
      }

      if (path === "/api/v1/login" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `login:${ipKey(request)}`, 10, 15 * 60_000)))
          return bad("too many attempts — wait 15 minutes", 429);
        const body = await request.json();
        const username = String(body.username || "").toLowerCase().trim();
        const password = String(body.password || "");
        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE username = ? OR address = ?"
        ).bind(username, username + "@" + DOMAIN).first();
        const ph = await passHash(password, user ? user.auth_salt : "AAAAAAAAAAAAAAAAAAAAAA==");
        if (!user || !constantTimeEq(ph, user.auth_hash)) return bad("invalid credentials", 401);

        const token = b64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare(
          "INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)"
        ).bind(await sha256hex(token), user.id, now(), now() + SESSION_TTL_MS, ua(request)).run();
        await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), user.id).run();
        return json({ token, user: publicUser(user) });
      }

      // ═══ MAILBOX ═══
      const me = await authUser(request, env);
      if (!me) return bad("unauthorized", 401);

      if (path === "/api/v1/me" && request.method === "GET") {
        return json(publicUser(me));
      }

      if (path === "/api/v1/logout" && request.method === "POST") {
        const token = bearer(request);
        await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256hex(token)).run();
        return json({ ok: true });
      }

      if (path === "/api/v1/users" && request.method === "GET" && url.searchParams.get("q")) {
        const q = url.searchParams.get("q").toLowerCase();
        const rows = await env.DB.prepare(
          "SELECT username FROM users WHERE username LIKE ? AND username != ? LIMIT 8"
        ).bind(`%${q}%`, me.username).all();
        return json({ users: rows.results.map((r) => r.username) });
      }

      let m;
      if ((m = path.match(/^\/api\/v1\/users\/([a-z0-9._-]+)\/pubkey$/)) && request.method === "GET") {
        const target = await env.DB.prepare("SELECT public_key, address FROM users WHERE username = ?").bind(m[1]).first();
        if (!target) return bad("no such user", 404);
        return json({ public_key: target.public_key, address: target.address });
      }

      if (path === "/api/v1/messages" && request.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT id, direction, peer_address, peer_label, subject, is_read, created_at
           FROM messages WHERE owner_id = ?
           ORDER BY created_at DESC LIMIT 200`
        ).bind(me.id).all();
        return json({ items: rows.results });
      }

      if ((m = path.match(/^\/api\/v1\/messages\/(\d+)$/)) && request.method === "GET") {
        const msg = await env.DB.prepare(
          `SELECT id, direction, peer_address, peer_label, subject, encrypted_aes_key,
                  iv, ciphertext, auth_tag, is_read, created_at
           FROM messages WHERE id = ? AND owner_id = ?`
        ).bind(m[1], me.id).first();
        if (!msg) return bad("not found", 404);
        if (!msg.is_read && msg.direction === "inbound") {
          await env.DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").bind(msg.id).run();
          msg.is_read = 1;
        }
        return json(msg);
      }

      if (path === "/api/v1/messages/send" && request.method === "POST") {
        const body = await request.json();
        const toUser = String(body.to_username || "").toLowerCase();
        const subject = String(body.subject || "").slice(0, 200);
        const target = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(toUser).first();
        if (!target) return bad("no such user", 404);

        const eak = String(body.encrypted_aes_key || "");
        const iv = String(body.iv || "");
        const ct = String(body.ciphertext || "");
        const tag = String(body.auth_tag || "");
        if (!eak || !iv || !ct || !tag) return bad("missing envelope");
        if (ct.length > 200_000) return bad("message too large");

        if (!(await rateLimit(env.DB, `send:${me.id}`, 30, 3_600_000)))
          return bad("rate limit (30/hour)", 429);

        const t = now();
        // sender's copy (encrypted with sender's own pubkey — frontend does this)
        const r1 = await env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(me.id, "outbound", target.address, target.username, subject, eak, iv, ct, tag, t).run();
        // recipient's copy — re-encrypted with recipient's pubkey happens
        // client-side only if the sender fetched the recipient's key. Here the
        // frontend encrypts once with the recipient's public key and posts one
        // envelope; we copy it to both owners.
        await env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(target.id, "inbound", me.address, me.username, subject, eak, iv, ct, tag, t).run();
        return json({ ok: true, id: r1.meta?.last_row_id });
      }

      if (path === "/api/v1/messages/delete" && request.method === "POST") {
        const { id } = await request.json();
        const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND owner_id = ?").bind(id, me.id).first();
        if (!row) return bad("not found", 404);
        await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      return bad("not found", 404);
    } catch (e) {
      return json({ detail: { message: "server error", raw: String((e && e.message) || e) } }, 500);
    }
  },

  async scheduled(_event, env) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM rl_counters WHERE bucket < ?").bind(Math.floor(t / 3_600_000) - 2),
    ]);
  },
};

function ua(request) {
  return String(request.headers.get("User-Agent") || "").slice(0, 120);
}
