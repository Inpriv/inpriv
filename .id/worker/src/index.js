// Inpriv ID — API router (account.inpriv.xyz).
// See lib.js for crypto/CORS/mail helpers and schema.sql for the data model.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import {
  SESSION_TTL_MS, PASS_ITERS,
  b64, now, uuid, sha256hex, json, bad, corsFor,
  passHash, constantTimeEq, sealString, openString,
  base32Decode, base32Encode, verifyTOTP,
  rateLimit, parseUA, ipPrefix, sendMail, emailShell, codeBlock,
  sessionCookie, clearCookie,
} from "./lib.js";

const newToken = () => b64(crypto.getRandomValues(new Uint8Array(32)));

async function publicUser(env, uid, full = false) {
  const u = await env.DB.prepare(
    "SELECT id, email, nick, email_verified, totp_enabled, created_at, last_login FROM users WHERE id = ?"
  ).bind(uid).first();
  if (!u) return null;
  const nick = u.nick || String(u.email || "user").split("@")[0].slice(0, 24);
  const out = {
    id: u.id,
    nick,
    avatar: "seed:" + u.id.slice(0, 8),
    email_verified: !!u.email_verified,
    totp_enabled: !!u.totp_enabled,
  };
  if (full) {
    out.email = u.email;
    out.created_at = u.created_at;
    out.last_login = u.last_login;
  }
  return out;
}

async function logEvent(db, uid, kind, req) {
  await db
    .prepare("INSERT INTO auth_events (id, user_id, kind, ip_prefix, ula, at) VALUES (?,?,?,?,?,?)")
    .bind(uuid(), uid, kind, ipPrefix(req), parseUA(req.headers.get("User-Agent")).slice(0, 80), now())
    .run();
}

async function createSession(db, userId, req, totpOk) {
  const token = newToken();
  const id = await sha256hex(token);
  const label = parseUA(req.headers.get("User-Agent"));
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, label, ip_prefix, created_at, last_used, expires_at, totp_ok) VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(id, userId, label, ipPrefix(req), now(), now(), now() + SESSION_TTL_MS, totpOk ? 1 : 0)
    .run();
  return { token, id };
}

async function rotateSession(db, row) {
  const token = newToken();
  const newId = await sha256hex(token);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE id = ?").bind(row.sid),
    db.prepare(
      "INSERT INTO sessions (id, user_id, label, ip_prefix, created_at, last_used, expires_at, totp_ok) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(newId, row.uid, row.label, row.ip_prefix, row.created_at, now(), row.expires_at, row.totp_ok),
  ]);
  return { token, id: newId };
}

function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function cookieToken(req) {
  const ck = req.headers.get("Cookie") || "";
  const m = ck.match(/(?:^|;\s*)inpriv_id=([^;]+)/);
  return m ? m[1] : null;
}

async function sessionByToken(env, token) {
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id sid, s.user_id uid, s.label, s.ip_prefix, s.created_at, s.last_used, s.expires_at, s.totp_ok,
            u.email, u.nick, u.email_verified, u.totp_enabled
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(id).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
  return row;
}

async function authUser(req, env, rotate = true) {
  let via = "bearer";
  let row = await sessionByToken(env, bearer(req));
  if (!row) {
    row = await sessionByToken(env, cookieToken(req));
    via = "cookie";
  }
  if (!row) return null;
  let token = null;
  // Rotate at most once per hour: keeps theft detection while allowing
  // short bursts of parallel requests with the same token.
  if (rotate && now() - row.last_used > 3_600_000) {
    const r = await rotateSession(env.DB, row);
    token = r.token;
    row = { ...row, sid: r.id };
  } else {
    await env.DB.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").bind(now(), row.sid).run();
  }
  return { row, token, uid: row.uid, via };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsFor(request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const gate = await maintenanceGate("account");
    if (gate.locked && path !== "/api/health") return maintenancePage("Inpriv ID", gate.message);

    // ── One Tap widget: /id.js — loadable from every *.inpriv.xyz page ──
    if (path === "/id.js" && request.method === "GET") {
      const res = await env.ASSETS.fetch(new URL("https://assets.local/id.js"));
      const body = await res.text();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // ── static frontend (login page + panel) for non-API GETs ──
    if (request.method === "GET" && !path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (path === "/api/health") {
      return json({ service: "inpriv-id", status: "ok", version: "1.0.0" });
    }

    try {
      // ═══ PUBLIC: REGISTER ═══
      if (path === "/api/register" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `reg:${ipPrefix(request)}`, 5, 3_600_000)))
          return bad("too many registrations from this network — try again later", 429);

        const body = await request.json();
        const email = String(body.email || "").toLowerCase().trim();
        const password = String(body.password || "");
        const nick = String(body.nick || "").trim().slice(0, 24);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return bad("invalid email address");
        if (password.length < 10) return bad("password too short (min 10 characters)");
        if (password.length > 200) return bad("password too long");
        if (nick && !/^[a-zA-Z0-9._-]{1,24}$/.test(nick)) return bad("nickname: 1-24 chars, letters/digits/._-");

        const dup = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
        if (dup) return bad("account with this email already exists", 409);

        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const ph = await passHash(password, salt);
        const uid = uuid();
        await env.DB.prepare(
          "INSERT INTO users (id, email, nick, pass_hash, pass_salt, pass_iters, created_at) VALUES (?,?,?,?,?,?,?)"
        ).bind(uid, email, nick || email.split("@")[0].slice(0, 24), ph, salt, PASS_ITERS, now()).run();
        await logEvent(env.DB, uid, "register", request);

        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
        await env.DB.prepare(
          "INSERT INTO email_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?,?,?,?,?)"
        ).bind(uuid(), uid, await sha256hex(code), "verify", now() + 15 * 60_000).run();
        const sent = await sendMail(
          env, email,
          "Confirm your Inpriv account",
          `Your verification code: ${code}\n\nIt expires in 15 minutes. If you didn't create this account, ignore this email.`,
          emailShell("Confirm your email",
            `Enter this code to finish creating your account:${codeBlock(code)}Expires in 15 minutes.`)
        );

        const s = await createSession(env.DB, uid, request, true);
        return json(
          { token: s.token, user: await publicUser(env, uid, true), verification_sent: sent.ok },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }

      // ═══ PUBLIC: LOGIN ═══
      if (path === "/api/login" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `login:${ipPrefix(request)}`, 10, 15 * 60_000)))
          return bad("too many attempts — wait 15 minutes", 429);

        const body = await request.json();
        const email = String(body.email || body.address || "").toLowerCase().trim();
        const password = String(body.password || "");
        const user = await env.DB.prepare(
          "SELECT id, pass_hash, pass_salt, pass_iters, totp_enabled FROM users WHERE email = ?"
        ).bind(email).first();

        // hash even when user missing (timingEqual-ish anti-enumeration)
        const ph = await passHash(password, user ? user.pass_salt : b64(encSalt(email)), user ? user.pass_iters : PASS_ITERS);
        const okFlag = user ? constantTimeEq(ph, user.pass_hash) : false;
        if (!okFlag) {
          if (user) await logEvent(env.DB, user.id, "login_fail", request);
          return bad("invalid email or password", 401);
        }
        await logEvent(env.DB, user.id, "login", request);

        if (user.totp_enabled) {
          const pending = newToken();
          const pid = await sha256hex("pending:" + pending);
          await env.DB.prepare(
            "INSERT INTO pending_2fa (id, user_id, created_at, expires_at, ip_prefix) VALUES (?,?,?,?,?)"
          ).bind(pid, user.id, now(), now() + 5 * 60_000, ipPrefix(request)).run();
          return json({ mfa_required: true, mfa_token: pending }, 200, cors);
        }

        const s = await createSession(env.DB, user.id, request, true);
        await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), user.id).run();
        return json(
          { token: s.token, user: await publicUser(env, user.id, true) },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }

      // ═══ PUBLIC: 2FA LOGIN STEP ═══
      if (path === "/api/login/2fa" && request.method === "POST") {
        const body = await request.json();
        const pending = String(body.mfa_token || "");
        const code = String(body.code || "").trim();
        const recovery = String(body.recovery || "").trim();
        const pid = await sha256hex("pending:" + pending);
        const p = await env.DB.prepare("SELECT id, user_id, expires_at FROM pending_2fa WHERE id = ?").bind(pid).first();
        if (!p || p.expires_at < now()) return bad("mfa session expired — log in again", 401);

        if (recovery) {
          const hash = await sha256hex(recovery.toLowerCase());
          const rc = await env.DB.prepare(
            "SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL"
          ).bind(p.user_id, hash).first();
          if (!rc) return bad("invalid recovery code", 401);
          await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?").bind(now(), rc.id).run();
          await logEvent(env.DB, p.user_id, "recovery_used", request);
        } else {
          if (!/^\d{6}$/.test(code)) return bad("enter the 6-digit code");
          const trow = await env.DB.prepare(
            "SELECT secret_enc FROM totp_secrets WHERE user_id = ? AND confirmed = 1"
          ).bind(p.user_id).first();
          const secret = trow ? await openString(env, trow.secret_enc) : null;
          if (!secret || !(await verifyTOTP(code, base32Decode(secret), now()))) {
            return bad("invalid code", 401);
          }
        }

        await env.DB.prepare("DELETE FROM pending_2fa WHERE id = ?").bind(pid).run();
        const s = await createSession(env.DB, p.user_id, request, true);
        await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), p.user_id).run();
        return json(
          { token: s.token, user: await publicUser(env, p.user_id, true) },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }

      // ═══ SESSION-SCOPED ═══
      const me = await authUser(request, env, true);

      // central responder: carries the rotated token (header for Bearer
      // clients, Set-Cookie for cookie sessions) so rotation never orphans
      // the legitimate client
      const out = (body, status = 200, extra = {}) => {
        const h = { ...cors, ...extra };
        if (me && me.token) {
          h["X-Inpriv-Token"] = me.token;
          if (me.via === "cookie") h["Set-Cookie"] = sessionCookie(me.token);
        }
        return json(body, status, h);
      };

      if (path === "/api/logout" && request.method === "POST") {
        if (me) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(me.row.sid).run();
        return out({ ok: true }, 200, { ...cors, "Set-Cookie": clearCookie() });
      }

      if (path === "/api/public/me" && request.method === "GET") {
        if (!me) return out({ user: null }, 200, cors);
        return out({ user: await publicUser(env, me.uid) }, 200, cors);
      }

      if (!me) return bad("unauthorized", 401);

      if (path === "/api/me" && request.method === "GET") {
        return out({ token: me.token || undefined, user: await publicUser(env, me.uid, true) }, 200, cors);
      }

      // ── vault (server-sealed encrypted profile blob) ──
      if (path === "/api/vault/get" && request.method === "GET") {
        const v = await env.DB.prepare("SELECT blob_enc, version FROM vault WHERE user_id = ?").bind(me.uid).first();
        return out({ vault: v ? v.blob_enc : null, version: v ? v.version : 0 }, 200, cors);
      }
      if (path === "/api/vault/set" && request.method === "POST") {
        const body = await request.json();
        const payload = JSON.stringify(body.vault || {});
        if (payload.length > 16_000) return bad("vault too large");
        const sealed = await sealString(env, payload);
        const v = await env.DB.prepare("SELECT version FROM vault WHERE user_id = ?").bind(me.uid).first();
        if (v) {
          await env.DB.prepare("UPDATE vault SET blob_enc = ?, version = version + 1, updated_at = ? WHERE user_id = ?")
            .bind(sealed, now(), me.uid).run();
          return out({ ok: true, version: v.version + 1 }, 200, cors);
        }
        await env.DB.prepare("INSERT INTO vault (user_id, blob_enc, version, updated_at) VALUES (?,?,1,?)")
          .bind(me.uid, sealed, now()).run();
        return out({ ok: true, version: 1 }, 200, cors);
      }

      // ── e-mail verification ──
      if (path === "/api/verify/send" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `verify:${me.uid}`, 5, 3_600_000))) return bad("limit reached — try again in an hour", 429);
        const user = await env.DB.prepare("SELECT email, email_verified FROM users WHERE id = ?").bind(me.uid).first();
        if (user.email_verified) return out({ ok: true, already: true }, 200, cors);
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
        await env.DB.prepare("INSERT INTO email_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?,?,?,?,?)")
          .bind(uuid(), me.uid, await sha256hex(code), "verify", now() + 15 * 60_000).run();
        const sent = await sendMail(env, user.email, "Your Inpriv verification code",
          `Code: ${code}`, emailShell("Verify your email", `Code:${codeBlock(code)}Expires in 15 minutes.`));
        return out({ ok: sent.ok, detail: sent.ok ? undefined : sent.reason }, 200, cors);
      }
      if (path === "/api/verify/confirm" && request.method === "POST") {
        const body = await request.json();
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code)) return bad("enter the 6-digit code");
        const hash = await sha256hex(code);
        const row = await env.DB.prepare(
          "SELECT id, expires_at, used_at FROM email_codes WHERE user_id = ? AND purpose = 'verify' AND code_hash = ? ORDER BY expires_at DESC LIMIT 1"
        ).bind(me.uid, hash).first();
        if (!row || row.used_at || row.expires_at < now()) return bad("invalid or expired code", 401);
        await env.DB.batch([
          env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE id = ?").bind(now(), row.id),
          env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(me.uid),
        ]);
        return out({ ok: true, user: await publicUser(env, me.uid, true) }, 200, cors);
      }

      // ── TOTP 2FA ──
      if (path === "/api/2fa/setup" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `tsetup:${me.uid}`, 5, 3_600_000))) return bad("try again later", 429);
        const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
        const urow = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(me.uid).first();
        const otpauth = `otpauth://totp/Inpriv:${encodeURIComponent(urow.email)}?secret=${secret}&issuer=Inpriv&algorithm=SHA1&digits=6&period=30`;
        await env.DB.prepare(
          "INSERT INTO totp_secrets (user_id, secret_enc, confirmed, created_at) VALUES (?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, confirmed = 0"
        ).bind(me.uid, await sealString(env, secret), now()).run();
        return out({ secret, otpauth, qr: `https://qr.inpriv.xyz/api/qr?data=${encodeURIComponent(otpauth)}&format=svg&ec=M` }, 200, cors);
      }
      if (path === "/api/2fa/confirm" && request.method === "POST") {
        const body = await request.json();
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code)) return bad("enter the 6-digit code");
        const trow = await env.DB.prepare("SELECT secret_enc FROM totp_secrets WHERE user_id = ?").bind(me.uid).first();
        const secret = trow ? await openString(env, trow.secret_enc) : null;
        if (!secret || !(await verifyTOTP(code, base32Decode(secret), now()))) {
          return bad("invalid code — try the next one", 401);
        }
        const codes = [];
        const stmts = [];
        for (let i = 0; i < 10; i++) {
          const raw = newToken().slice(0, 4) + "-" + newToken().slice(0, 4);
          codes.push(raw);
          stmts.push(env.DB.prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?,?,?)")
            .bind(uuid(), me.uid, await sha256hex(raw.toLowerCase())));
        }
        stmts.push(env.DB.prepare("UPDATE totp_secrets SET confirmed = 1 WHERE user_id = ?").bind(me.uid));
        stmts.push(env.DB.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").bind(me.uid));
        await env.DB.batch(stmts);
        await logEvent(env.DB, me.uid, "totp_on", request);
        return out({ ok: true, recovery_codes: codes }, 200, cors);
      }
      if (path === "/api/2fa/disable" && request.method === "POST") {
        const body = await request.json();
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters FROM users WHERE id = ?").bind(me.uid).first();
        const candidate = await passHash(String(body.password || ""), u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("wrong password", 401);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM totp_secrets WHERE user_id = ?").bind(me.uid),
          env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(me.uid),
          env.DB.prepare("UPDATE users SET totp_enabled = 0 WHERE id = ?").bind(me.uid),
        ]);
        await logEvent(env.DB, me.uid, "totp_off", request);
        return out({ ok: true }, 200, cors);
      }

      // ── sessions ──
      if (path === "/api/sessions" && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT id, label, ip_prefix, created_at, last_used, expires_at, totp_ok FROM sessions WHERE user_id = ? ORDER BY last_used DESC"
        ).bind(me.uid).all();
        return out({ sessions: rows.results.map((r) => ({ ...r, current: r.id === me.row.sid })) }, 200, cors);
      }
      if (path === "/api/sessions/revoke" && request.method === "POST") {
        const { id } = await request.json();
        const row = await env.DB.prepare("SELECT id FROM sessions WHERE id = ? AND user_id = ?").bind(id, me.uid).first();
        if (!row) return bad("not found", 404);
        await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
        return out({ ok: true }, 200, cors);
      }
      if (path === "/api/sessions/revoke-all" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (body.all) {
          await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(me.uid).run();
          return out({ ok: true }, 200, { ...cors, "Set-Cookie": clearCookie() });
        }
        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.uid, me.row.sid).run();
        return out({ ok: true }, 200, cors);
      }

      // ── security log ──
      if (path === "/api/events" && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT kind, ip_prefix, ula, at FROM auth_events WHERE user_id = ? ORDER BY at DESC LIMIT 30"
        ).bind(me.uid).all();
        return out({ events: rows.results }, 200, cors);
      }

      // ── profile ──
      if (path === "/api/profile" && request.method === "POST") {
        const body = await request.json();
        const nick = String(body.nick ?? "").trim().slice(0, 24);
        if (nick && !/^[a-zA-Z0-9._-]{1,24}$/.test(nick)) return bad("nickname: 1-24 chars, letters/digits/._-");
        await env.DB.prepare("UPDATE users SET nick = ? WHERE id = ?").bind(nick || null, me.uid).run();
        return out({ ok: true, user: await publicUser(env, me.uid, true) }, 200, cors);
      }

      // ── password change ──
      if (path === "/api/password/change" && request.method === "POST") {
        const body = await request.json();
        const current = String(body.current || "");
        const next = String(body.next || "");
        if (next.length < 10) return bad("new password too short (min 10)");
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters FROM users WHERE id = ?").bind(me.uid).first();
        const candidate = await passHash(current, u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("current password is wrong", 401);
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const ph = await passHash(next, salt);
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iters = ? WHERE id = ?")
            .bind(ph, salt, PASS_ITERS, me.uid),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.uid, me.row.sid),
        ]);
        await logEvent(env.DB, me.uid, "pass_change", request);
        return out({ ok: true }, 200, cors);
      }

      // ── account deletion ──
      if (path === "/api/account/delete" && request.method === "POST") {
        const body = await request.json();
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters FROM users WHERE id = ?").bind(me.uid).first();
        const candidate = await passHash(String(body.password || ""), u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("wrong password", 401);
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(me.uid).run();
        return out({ ok: true }, 200, { ...cors, "Set-Cookie": clearCookie() });
      }

      return bad("not found", 404);
    } catch (e) {
      return json({ error: "server error", detail: String((e && e.message) || e) }, 500);
    }
  },
};

// deterministic fake salt for anti-enumeration timing (never used for login)
function encSalt(email) {
  const e = new TextEncoder().encode("pepper:" + email);
  return b64(e.subarray(0, 16));
}
