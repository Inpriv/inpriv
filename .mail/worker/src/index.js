// Inpriv Mail — Zero-Knowledge Mail (mail.inpriv.xyz)
// Integrated with Inpriv ID (id.inpriv.xyz) & M3 Earthy Forest.

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

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  if (
    origin === "https://inpriv.xyz" ||
    origin === "https://www.inpriv.xyz" ||
    origin === "https://mail.inpriv.xyz" ||
    origin === "https://id.inpriv.xyz" ||
    origin === "https://temp.inpriv.xyz" ||
    /^https:\/\/[a-z0-9-]+\.inpriv\.xyz$/.test(origin)
  ) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

const bad = (msg, status = 400, extra = {}) =>
  json({ error: msg, detail: { message: msg } }, status, extra);

// ── Password hashing (Chained PBKDF2-SHA256, matches Inpriv ID) ────────────
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

// ── Rate Limiting ──────────────────────────────────────────────────────────
async function rateLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(now() / windowMs);
  try {
    const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
    if (row && row.c >= limit) return false;
    await db.prepare("INSERT INTO rl_counters (k, bucket, c) VALUES (?,?,1) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
      .bind(key, bucket).run();
    return true;
  } catch {
    return true; // fail open on rate limit table error
  }
}

function ipKey(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return parts.slice(0, 2).join(".");
  return ip.slice(0, 12);
}

function ua(req) {
  return String(req.headers.get("User-Agent") || "").slice(0, 120);
}

// ── Sessions & Auth ────────────────────────────────────────────────────────
function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function publicUser(u, extra = {}) {
  return {
    id: u.id,
    username: u.username,
    email: u.address || `${u.username}@${DOMAIN}`,
    address: u.address || `${u.username}@${DOMAIN}`,
    public_key: u.public_key,
    encrypted_private_key: u.encrypted_private_key,
    priv_iv: u.priv_iv,
    priv_salt: u.priv_salt,
    priv_iter: u.priv_iter,
    created_at: u.created_at,
    ...extra,
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

// ── Server-side Hybrid Encryption (for external inbound email) ─────────────
async function serverHybridEncrypt(pubKeyB64, plaintextStr) {
  const pubKey = await crypto.subtle.importKey(
    "spki",
    b64d(pubKeyB64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(plaintextStr));
  const ctBytes = new Uint8Array(ctBuf);
  const ciphertext = ctBytes.slice(0, ctBytes.length - 16);
  const tag = ctBytes.slice(ctBytes.length - 16);
  const rawAes = await crypto.subtle.exportKey("raw", aesKey);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, rawAes);
  return {
    encrypted_aes_key: b64(wrapped),
    iv: b64(iv.buffer),
    ciphertext: b64(ciphertext.buffer),
    auth_tag: b64(tag.buffer),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Static frontend assets pass-through
    if (!path.startsWith("/api/")) {
      const gate = await maintenanceGate("mail");
      if (gate.locked) return maintenancePage("Inpriv Mail", gate.message);
      return env.ASSETS.fetch(request);
    }

    const gate = await maintenanceGate("mail");
    if (gate.locked && path !== "/api/v1/health") {
      return maintenancePage("Inpriv Mail", gate.message);
    }

    if (path === "/api/v1/health") {
      return json({ status: "ok", service: "inpriv-mail", domain: DOMAIN, time: now() }, 200, cors);
    }

    try {
      // ══════════════════════════════════════════════════════════════════════
      // 1. PUBLIC AUTH & DISCOVERY
      // ══════════════════════════════════════════════════════════════════════

      // ── Check Username Availability ──────────────────────────────────────
      if (path === "/api/v1/available" && request.method === "GET") {
        let local = (url.searchParams.get("username") || "").toLowerCase().trim();
        if (local.endsWith("@inpriv.xyz")) local = local.slice(0, -"@inpriv.xyz".length).trim();
        if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(local)) {
          return json({ available: false, valid: false }, 200, cors);
        }

        const mailUser = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(local).first();
        let idUser = null;
        if (env.ID_DB) {
          idUser = await env.ID_DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(local).first();
        }

        return json({
          available: !mailUser && !idUser,
          valid: true,
          inpriv_id_exists: !!idUser,
          mail_exists: !!mailUser,
        }, 200, cors);
      }

      // ── Check Inpriv ID Account Status ────────────────────────────────────
      if (path === "/api/v1/id-status" && request.method === "GET") {
        let local = (url.searchParams.get("username") || "").toLowerCase().trim();
        if (local.endsWith("@inpriv.xyz")) local = local.slice(0, -"@inpriv.xyz".length).trim();

        let idUser = null;
        if (env.ID_DB && local) {
          idUser = await env.ID_DB.prepare(
            "SELECT id, username, email, nick FROM users WHERE username = ? OR email = ?"
          ).bind(local, `${local}@${DOMAIN}`).first();
        }

        let mailUser = null;
        if (local) {
          mailUser = await env.DB.prepare("SELECT id, username, address, public_key FROM users WHERE username = ?")
            .bind(local).first();
        }

        return json({
          username: local,
          inpriv_id_user: idUser ? { username: idUser.username, email: idUser.email, nick: idUser.nick } : null,
          has_mail_keys: !!(mailUser && mailUser.public_key),
        }, 200, cors);
      }

      // ── Login (Checks Inpriv Mail & Inpriv ID) ─────────────────────────────
      if (path === "/api/v1/login" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `login:${ipKey(request)}`, 15, 15 * 60_000))) {
          return bad("too many attempts — please wait 15 minutes", 429, cors);
        }

        const body = await request.json();
        let username = String(body.username || body.login || body.address || "").toLowerCase().trim();
        if (username.endsWith("@inpriv.xyz")) username = username.slice(0, -"@inpriv.xyz".length).trim();
        const password = String(body.password || "");
        if (!username || !password) return bad("username and password required", 400, cors);

        // 1. Check Inpriv Mail DB
        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE username = ? OR address = ?"
        ).bind(username, `${username}@${DOMAIN}`).first();

        if (user) {
          const ph = await passHash(password, user.auth_salt, user.priv_iter || PASS_ITERS);
          if (constantTimeEq(ph, user.auth_hash)) {
            const token = b64(crypto.getRandomValues(new Uint8Array(32)));
            await env.DB.prepare(
              "INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)"
            ).bind(await sha256hex(token), user.id, now(), now() + SESSION_TTL_MS, ua(request)).run();
            await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), user.id).run();
            return json({ token, user: publicUser(user, { inpriv_id_synced: true }) }, 200, cors);
          }
          return bad("invalid credentials", 401, cors);
        }

        // 2. Not in Inpriv Mail, check Inpriv ID DB (SSO sync)
        if (env.ID_DB) {
          const idUser = await env.ID_DB.prepare(
            `SELECT id, username, email, nick, pass_hash, pass_salt, pass_iters
             FROM users
             WHERE username = ? OR email = ? OR recovery_email = ?`
          ).bind(username, `${username}@${DOMAIN}`, username).first();

          if (idUser) {
            const ph = await passHash(password, idUser.pass_salt, idUser.pass_iters || PASS_ITERS);
            if (constantTimeEq(ph, idUser.pass_hash)) {
              // Valid Inpriv ID user, needs to initialize RSA keys in Mail
              return json({
                status: "needs_init",
                inpriv_id: true,
                username: idUser.username,
                email: idUser.email,
                nick: idUser.nick || idUser.username,
                message: "Inpriv ID account verified. Initialize your zero-knowledge encryption keys to access mailbox.",
              }, 200, cors);
            }
          }
        }

        return bad("invalid credentials", 401, cors);
      }

      // ── Initialize Keys for Inpriv ID User ────────────────────────────────
      if (path === "/api/v1/init-keys" && request.method === "POST") {
        const body = await request.json();
        let username = String(body.username || "").toLowerCase().trim();
        if (username.endsWith("@inpriv.xyz")) username = username.slice(0, -"@inpriv.xyz".length).trim();
        const password = String(body.password || "");

        const pubkey = String(body.public_key || "");
        const epk = String(body.encrypted_private_key || "");
        const privIv = String(body.priv_iv || "");
        const privSalt = String(body.priv_salt || "");
        const privIter = parseInt(body.priv_iter, 10) || PASS_ITERS;

        if (!username || !password || !pubkey || !epk || !privIv || !privSalt) {
          return bad("missing crypto parameters or credentials", 400, cors);
        }

        // Verify with Inpriv ID database
        if (!env.ID_DB) return bad("Inpriv ID database unavailable", 500, cors);
        const idUser = await env.ID_DB.prepare(
          "SELECT id, username, email, pass_hash, pass_salt, pass_iters FROM users WHERE username = ? OR email = ?"
        ).bind(username, `${username}@${DOMAIN}`).first();

        if (!idUser) return bad("Inpriv ID account not found", 404, cors);
        const ph = await passHash(password, idUser.pass_salt, idUser.pass_iters || PASS_ITERS);
        if (!constantTimeEq(ph, idUser.pass_hash)) return bad("invalid Inpriv ID password", 401, cors);

        // Check if already in Mail DB
        const existing = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(idUser.username).first();
        const authSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const authHash = await passHash(password, authSalt, privIter);
        const address = `${idUser.username}@${DOMAIN}`;

        let uid;
        if (existing) {
          await env.DB.prepare(
            `UPDATE users SET auth_hash = ?, auth_salt = ?, public_key = ?, encrypted_private_key = ?,
                              priv_iv = ?, priv_salt = ?, priv_iter = ?, last_login = ?
             WHERE id = ?`
          ).bind(authHash, authSalt, pubkey, epk, privIv, privSalt, privIter, now(), existing.id).run();
          uid = existing.id;
        } else {
          const res = await env.DB.prepare(
            `INSERT INTO users (username, address, auth_hash, auth_salt, public_key,
                                encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at, last_login)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(idUser.username, address, authHash, authSalt, pubkey, epk, privIv, privSalt, privIter, now(), now()).run();
          uid = res.meta?.last_row_id;
        }

        const token = b64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare(
          "INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)"
        ).bind(await sha256hex(token), uid, now(), now() + SESSION_TTL_MS, ua(request)).run();

        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
        return json({ token, user: publicUser(user, { inpriv_id_synced: true }) }, 200, cors);
      }

      // ── Register New Account ──────────────────────────────────────────────
      if (path === "/api/v1/register" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `reg:${ipKey(request)}`, 5, 3_600_000))) {
          return bad("too many registrations — please try again later", 429, cors);
        }

        const body = await request.json();
        let username = String(body.username || "").toLowerCase().trim();
        if (username.endsWith("@inpriv.xyz")) username = username.slice(0, -"@inpriv.xyz".length).trim();
        const password = String(body.password || "");
        const passwordConfirm = String(body.password_confirm || body.passwordConfirm || "");

        if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(username)) {
          return bad("invalid username (2-32 chars: a-z 0-9 . _ -)", 400, cors);
        }
        if (password.length < 10) return bad("password too short (minimum 10 characters)", 400, cors);
        if (passwordConfirm && password !== passwordConfirm) return bad("passwords do not match", 400, cors);

        const pubkey = String(body.public_key || "");
        const epk = String(body.encrypted_private_key || "");
        const privIv = String(body.priv_iv || "");
        const privSalt = String(body.priv_salt || "");
        const privIter = parseInt(body.priv_iter, 10) || PASS_ITERS;

        if (!pubkey || !epk || !privIv || !privSalt) {
          return bad("missing client crypto envelope", 400, cors);
        }

        const address = `${username}@${DOMAIN}`;

        // Check if username taken in Mail
        const dupMail = await env.DB.prepare("SELECT 1 FROM users WHERE username = ? OR address = ?")
          .bind(username, address).first();
        if (dupMail) return bad("username already registered on Inpriv Mail", 409, cors);

        // Check if username taken in Inpriv ID
        if (env.ID_DB) {
          const dupId = await env.ID_DB.prepare("SELECT 1 FROM users WHERE username = ? OR email = ?")
            .bind(username, address).first();
          if (dupId) {
            return bad("username belongs to an Inpriv ID account. Please sign in with your Inpriv ID password to activate your mailbox.", 409, cors);
          }
        }

        const authSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const authHash = await passHash(password, authSalt, privIter);

        const res = await env.DB.prepare(
          `INSERT INTO users (username, address, auth_hash, auth_salt, public_key,
                              encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at, last_login)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(username, address, authHash, authSalt, pubkey, epk, privIv, privSalt, privIter, now(), now()).run();
        const uid = res.meta?.last_row_id;

        const token = b64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare(
          "INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)"
        ).bind(await sha256hex(token), uid, now(), now() + SESSION_TTL_MS, ua(request)).run();

        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
        return json({ token, user: publicUser(user) }, 200, cors);
      }

      // ── Search Users / Autocomplete ───────────────────────────────────────
      if (path === "/api/v1/users" && request.method === "GET") {
        const q = (url.searchParams.get("q") || "").toLowerCase().trim();
        if (!q || q.length < 1) return json({ users: [] }, 200, cors);

        const mailUsers = await env.DB.prepare(
          "SELECT username FROM users WHERE username LIKE ? LIMIT 8"
        ).bind(`%${q}%`).all();

        const results = new Set((mailUsers.results || []).map((r) => r.username));

        if (env.ID_DB) {
          const idUsers = await env.ID_DB.prepare(
            "SELECT username FROM users WHERE username LIKE ? LIMIT 8"
          ).bind(`%${q}%`).all();
          (idUsers.results || []).forEach((r) => { if (r.username) results.add(r.username); });
        }

        return json({ users: Array.from(results).slice(0, 10) }, 200, cors);
      }

      // ── Get User Public Key (for Encryption) ──────────────────────────────
      let m;
      if ((m = path.match(/^\/api\/v1\/users\/([a-z0-9._-]+)\/pubkey$/)) && request.method === "GET") {
        const targetUsername = m[1].toLowerCase();
        const target = await env.DB.prepare(
          "SELECT public_key, address FROM users WHERE username = ?"
        ).bind(targetUsername).first();

        if (target && target.public_key) {
          return json({ public_key: target.public_key, address: target.address, has_keys: true }, 200, cors);
        }

        // If in Inpriv ID but not yet initialized in Mail
        if (env.ID_DB) {
          const idTarget = await env.ID_DB.prepare(
            "SELECT username, email FROM users WHERE username = ? OR email = ?"
          ).bind(targetUsername, `${targetUsername}@${DOMAIN}`).first();
          if (idTarget) {
            return json({
              public_key: null,
              address: idTarget.email || `${idTarget.username}@${DOMAIN}`,
              has_keys: false,
              inpriv_id: true,
              message: "User exists in Inpriv ID but has not yet initialized their encrypted mailbox keys.",
            }, 200, cors);
          }
        }

        return bad("recipient not found", 404, cors);
      }

      // ══════════════════════════════════════════════════════════════════════
      // 2. AUTHENTICATED MAILBOX OPERATIONS
      // ══════════════════════════════════════════════════════════════════════

      const me = await authUser(request, env);
      if (!me) return bad("unauthorized — session invalid or expired", 401, cors);

      // ── Get Current Profile ───────────────────────────────────────────────
      if (path === "/api/v1/me" && request.method === "GET") {
        return json(publicUser(me), 200, cors);
      }

      // ── Logout ────────────────────────────────────────────────────────────
      if (path === "/api/v1/logout" && request.method === "POST") {
        const token = bearer(request);
        if (token) {
          await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256hex(token)).run();
        }
        return json({ ok: true }, 200, cors);
      }

      // ── List Messages ─────────────────────────────────────────────────────
      if (path === "/api/v1/messages" && request.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT id, direction, peer_address, peer_label, subject, is_read, created_at
           FROM messages WHERE owner_id = ?
           ORDER BY created_at DESC LIMIT 200`
        ).bind(me.id).all();
        return json({ items: rows.results || [] }, 200, cors);
      }

      // ── Get Single Message Envelope (Marks Read) ──────────────────────────
      if ((m = path.match(/^\/api\/v1\/messages\/(\d+)$/)) && request.method === "GET") {
        const msg = await env.DB.prepare(
          `SELECT id, direction, peer_address, peer_label, subject, encrypted_aes_key,
                  iv, ciphertext, auth_tag, is_read, created_at
           FROM messages WHERE id = ? AND owner_id = ?`
        ).bind(m[1], me.id).first();

        if (!msg) return bad("message not found", 404, cors);

        if (!msg.is_read && msg.direction === "inbound") {
          await env.DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").bind(msg.id).run();
          msg.is_read = 1;
        }
        return json(msg, 200, cors);
      }

      // ── Send Message (Inpriv Zero-Knowledge E2EE or External Relay) ─────────
      if (path === "/api/v1/messages/send" && request.method === "POST") {
        const body = await request.json();
        let rawTo = String(body.to_username || body.to || "").toLowerCase().trim();
        const subject = String(body.subject || "").slice(0, 200);
        const isExternal = body.mode === "external" || (rawTo.includes("@") && !rawTo.endsWith("@" + DOMAIN));

        if (!(await rateLimit(env.DB, `send:${me.id}`, 40, 3_600_000))) {
          return bad("rate limit exceeded (40 messages/hour)", 429, cors);
        }

        const t = now();

        if (isExternal) {
          const toEmail = rawTo;
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) {
            return bad("invalid recipient email address", 400, cors);
          }

          const resendKey = env.RESEND_API_KEY || env.RESEND_KEY;
          if (!resendKey) {
            return bad("external email relay is not configured on this server (RESEND_API_KEY / RESEND_KEY required)", 503, cors);
          }

          const textBody = String(body.text || body.body || "").slice(0, 50_000);
          if (!textBody) {
            return bad("message body cannot be empty", 400, cors);
          }

          // Support sender's encrypted envelope so they can decrypt in their Sent mailbox
          const sndEak = String((body.sender_envelope && body.sender_envelope.encrypted_aes_key) || body.sender_encrypted_aes_key || "");
          const iv = String((body.sender_envelope && body.sender_envelope.iv) || body.iv || "");
          const ct = String((body.sender_envelope && body.sender_envelope.ciphertext) || body.ciphertext || "");
          const tag = String((body.sender_envelope && body.sender_envelope.auth_tag) || body.auth_tag || "");

          if (!sndEak || !iv || !ct || !tag) {
            return bad("missing sender encrypted envelope for Sent box", 400, cors);
          }

          // Send via Resend API
          let resendRes;
          try {
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${resendKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: `${me.username}@${DOMAIN}`,
                to: toEmail,
                subject: subject || "(no subject)",
                text: textBody,
              }),
            });
            resendRes = { status: res.status, body: await res.json().catch(() => ({})) };
          } catch (err) {
            return bad("could not reach external email relay: " + (err.message || String(err)), 502, cors);
          }

          if (resendRes.status >= 400) {
            return bad("mail relay error: " + (resendRes.body?.message || "failed to send"), 502, cors);
          }

          // Store Sender's Outbound Copy (encrypted with Sender's public key)
          const peerLabel = toEmail.split("@")[0];
          const r1 = await env.DB.prepare(
            `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                   encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read)
             VALUES (?,?,?,?,?,?,?,?,?,?,1)`
          ).bind(me.id, "outbound", toEmail, peerLabel, subject, sndEak, iv, ct, tag, t).run();

          return json({ ok: true, id: r1.meta?.last_row_id, external: true, resend_id: resendRes.body?.id }, 200, cors);
        }

        // Internal Inpriv E2EE message
        let toUser = rawTo;
        if (toUser.endsWith("@" + DOMAIN)) toUser = toUser.slice(0, -("@" + DOMAIN).length).trim();

        const target = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(toUser).first();
        if (!target) {
          return bad("recipient not found or has not initialized an encrypted mailbox", 404, cors);
        }

        // Support structured recipient/sender envelopes or flat fields
        const recEak = String((body.recipient_envelope && body.recipient_envelope.encrypted_aes_key) || body.encrypted_aes_key || "");
        const sndEak = String((body.sender_envelope && body.sender_envelope.encrypted_aes_key) || body.sender_encrypted_aes_key || recEak);
        const iv = String((body.recipient_envelope && body.recipient_envelope.iv) || body.iv || "");
        const ct = String((body.recipient_envelope && body.recipient_envelope.ciphertext) || body.ciphertext || "");
        const tag = String((body.recipient_envelope && body.recipient_envelope.auth_tag) || body.auth_tag || "");

        if (!recEak || !iv || !ct || !tag) return bad("missing encrypted message envelope", 400, cors);
        if (ct.length > 300_000) return bad("message body exceeds maximum size (200 KB)", 400, cors);

        // 1. Sender's Outbound Copy (encrypted with Sender's public key)
        const r1 = await env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read)
           VALUES (?,?,?,?,?,?,?,?,?,?,1)`
        ).bind(me.id, "outbound", target.address, target.username, subject, sndEak, iv, ct, tag, t).run();

        // 2. Recipient's Inbound Copy (encrypted with Recipient's public key)
        await env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read)
           VALUES (?,?,?,?,?,?,?,?,?,?,0)`
        ).bind(target.id, "inbound", me.address, me.username, subject, recEak, iv, ct, tag, t).run();

        return json({ ok: true, id: r1.meta?.last_row_id, external: false }, 200, cors);
      }

      // ── Delete Message ────────────────────────────────────────────────────
      if (path === "/api/v1/messages/delete" && request.method === "POST") {
        const { id } = await request.json();
        const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND owner_id = ?")
          .bind(id, me.id).first();
        if (!row) return bad("message not found", 404, cors);
        await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
        return json({ ok: true }, 200, cors);
      }

      return bad("endpoint not found", 404, cors);
    } catch (e) {
      return json({
        error: "internal server error",
        detail: { message: (e && e.message) || String(e) },
      }, 500, cors);
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
