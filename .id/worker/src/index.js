// Inpriv ID — API router (id.inpriv.xyz).
// See lib.js for crypto/CORS/mail helpers and schema.sql for the data model.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { logAccess } from "../../../common/access-log.js";
import { notFound } from "../../../common/errors.js";
import { canonicalRedirect } from "../../../common/canonical.js";
import { clientNet, originAllowed, isUnsafeMethod, pageResponse, withHeaders } from "../../../common/security.js";
import { isReservedLocal, claimStatement, ensureClaims, backfillIdClaims, claimOwner } from "../../../common/addresses.js";
import {
  SESSION_TTL_MS, PASS_ITERS,
  b64, now, uuid, sha256hex, json, bad, corsFor, allowedOrigins,
  passHash, constantTimeEq, sealString, openString,
  base32Decode, base32Encode, verifyTOTP,
  rateLimit, overLimit, bump, parseUA, ipPrefix, sendMail, emailShell, emailAddr, codeBlock,
  sessionCookie, clearCookie, protectCode, codeMatches, consumeFactor, factorStatement,
} from "./lib.js";

const newToken = () => b64(crypto.getRandomValues(new Uint8Array(32)));

// A single-use, 10-minute ticket that lets the page create the Mail mailbox
// straight after sign-up. It is written to id_init_tickets, the table Inpriv
// Mail reads, so Mail stays the only code that creates a mailbox.
async function mintInitTicket(env, username) {
  const tkt = newToken();
  await env.DB.prepare(
    "INSERT INTO id_init_tickets (id, username, created_at, expires_at, kind) VALUES (?,?,?,?,?)"
  ).bind(await sha256hex(tkt), username, now(), now() + 10 * 60_000, "init").run();
  return tkt;
}

// Services that redeem Quick Sign-In grants (data-service ids). Shown in the
// Privacy tab under "Connected services" with their consent state.
const SERVICE_META = {
  mail: { name: "Inpriv Mail", icon: "mail", url: "https://mail.inpriv.xyz" },
};

async function publicUser(env, uid, full = false) {
  const u = await env.DB.prepare(
    "SELECT id, username, email, recovery_email, pending_recovery_email, nick, email_verified, recovery_email_verified, totp_enabled, show_address, suggest_address, created_at, last_login FROM users WHERE id = ?"
  ).bind(uid).first();
  if (!u) return null;
  const username = u.username || (u.email ? u.email.split("@")[0] : "user");
  const nick = u.nick || username;
  const inprivEmail = u.email || `${username}@inpriv.xyz`;
  const out = {
    id: u.id,
    username,
    email: inprivEmail,
    inpriv_email: inprivEmail,
    nick,
    avatar: "seed:" + u.id.slice(0, 8),
    email_verified: !!(u.recovery_email_verified || u.email_verified),
    totp_enabled: !!u.totp_enabled,
    // Both off by default: people you write to see "Anonymous Inpriv user",
    // and your address is never offered in someone else's composer.
    show_address: u.show_address === 1,
    suggest_address: u.suggest_address === 1,
  };
  if (full) {
    out.recovery_email = u.pending_recovery_email || u.recovery_email || null;
    out.recovery_email_verified = !u.pending_recovery_email && !!u.recovery_email_verified;
    out.created_at = u.created_at;
    out.last_login = u.last_login;
  }
  return out;
}

// Compatibility helpers remain for callers; migrations own the schema.
// Usernames of deleted accounts. Kept forever so an address is never
// reassigned (ID sign-up and Temp custom names both check it).
async function ensureRetired(db) { /* Schema is managed by D1 migrations. */ }

async function ensureTables(env) { /* Schema is managed by D1 migrations. */ }

async function logEvent(db, uid, kind, req) {
  await db
    .prepare("INSERT INTO auth_events (id, user_id, kind, ip_prefix, ula, at) VALUES (?,?,?,?,?,?)")
    .bind(uuid(), uid, kind, ipPrefix(req), parseUA(req.headers.get("User-Agent")).slice(0, 80), now())
    .run();
  // full record for abuse reports and legal requests (common/access-log.js)
  const u = await db.prepare("SELECT username FROM users WHERE id = ?").bind(uid).first().catch(() => null);
  await logAccess(db, req, "id", kind, u ? u.username : uid);
}

// Recovery-email code. Earlier unused codes are deleted first, so the only
// valid code is the latest one, for the address currently on the account.
async function sendRecoveryCode(env, uid) {
  const u = await env.DB.prepare("SELECT email, COALESCE(pending_recovery_email, recovery_email) AS recovery_email, CASE WHEN pending_recovery_email IS NULL THEN recovery_email_verified ELSE 0 END AS recovery_email_verified FROM users WHERE id = ?").bind(uid).first();
  if (!u || !u.recovery_email) return { ok: false, status: 400, error: "add a recovery email first" };
  if (u.recovery_email_verified) return { ok: true, already: true };
  // Same acknowledgement, but no email to somebody else's owned address.
  if (await env.DB.prepare("SELECT 1 FROM users WHERE recovery_email = ? AND id != ?").bind(u.recovery_email, uid).first()) return { ok: true };

  if (!(await rateLimit(env.DB, `verify:${uid}`, 5, 3_600_000))) {
    return { ok: false, status: 429, error: "too many codes — try again in an hour" };
  }
  if (!(await rateLimit(env.DB, `recipient:${await sha256hex(u.recovery_email)}`, 3, 3_600_000)))
    return { ok: false, status: 429, error: "too many emails to this address — try again in an hour" };
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").bind(uid),
    env.DB.prepare("INSERT INTO email_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?,?,?,?,?)")
      .bind(uuid(), uid, await protectCode(env, u.recovery_email + "\0" + code), "verify", now() + 15 * 60_000),
  ]);
  const to = u.recovery_email;
  const sent = await sendMail(env, to, `${code} is your Inpriv verification code`,
    `Confirm ${to} as the recovery email for ${u.email}.\n\nYour code: ${code}\n\nEnter it on id.inpriv.xyz. It expires in 15 minutes.\n\nDidn't ask for this? You can ignore this email.`,
    emailShell("Confirm your recovery email",
      `Enter this code on <a href="https://id.inpriv.xyz" style="color:inherit">id.inpriv.xyz</a> to use ${emailAddr(to)} as the recovery email for ${emailAddr(u.email)}.` +
      `${codeBlock(code)}It expires in 15 minutes.`,
      `Your code: ${code}. It expires in 15 minutes.`));
  if (!sent.ok) {
    console.error("recovery code: mail not sent", sent.reason);
    return { ok: false, status: 502, error: "couldn't send the code right now — try again in a few minutes" };
  }
  return { ok: true };
}

async function createSession(db, userId, req, totpOk, factor = null) {
  const token = newToken();
  const id = await sha256hex(token);
  const label = parseUA(req.headers.get("User-Agent"));
  const insert = db.prepare(
    "INSERT INTO sessions (id, user_id, label, ip_prefix, created_at, last_used, expires_at, totp_ok) SELECT ?,?,?,?,?,?,?,?" + (factor ? " WHERE changes() = 1" : "")
  ).bind(id, userId, label, ipPrefix(req), now(), now(), now() + SESSION_TTL_MS, totpOk ? 1 : 0);
  if (factor) {
    const result = await db.batch([factor, insert]);
    if (result[1].meta.changes !== 1) return null;
  } else await insert.run();
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
            u.username, u.email, u.recovery_email, u.nick, u.email_verified, u.recovery_email_verified, u.totp_enabled
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
  } else if (now() - row.last_used >= 300_000) {
    await env.DB.prepare("UPDATE sessions SET last_used = ? WHERE id = ? AND last_used <= ?").bind(now(), row.sid, now() - 300_000).run();
  }
  return { row, token, uid: row.uid, via };
}

// One reserved list for every service (common/addresses.js). It also covers
// the retired Temp address pattern ("amber-fox-123").
const isReservedUsername = isReservedLocal;

// Mail keeps its own sessions. Changing the password, 2FA, or signing out
// everywhere on Inpriv ID ends them too, so a stolen Mail session doesn't
// outlive the account change.
async function revokeMailSessions(env, uid) {
  try {
    if (!env.MAIL_DB) return;
    const u = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(uid).first();
    if (!u || !u.username) return;
    await env.MAIL_DB.prepare(
      "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)"
    ).bind(u.username).run();
  } catch { /* the mailbox may not exist yet */ }
}

// Quick Unlock keys live in Mail (device_keys, one row per device). The
// switch here counts them and, when turned off, removes them through the
// shared Mail database. Best-effort: the table may not exist yet.
async function mailDeviceKeys(env, uid, op) {
  try {
    if (!env.MAIL_DB) return op === "count" ? 0 : undefined;
    const u = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(uid).first();
    const mu = u && await env.MAIL_DB.prepare("SELECT id FROM users WHERE username = ?").bind(u.username).first();
    if (!mu) return op === "count" ? 0 : undefined;
    if (op === "clear") {
      await env.MAIL_DB.prepare("DELETE FROM device_keys WHERE user_id = ?").bind(mu.id).run();
      return;
    }
    const r = await env.MAIL_DB.prepare("SELECT COUNT(*) AS n FROM device_keys WHERE user_id = ?").bind(mu.id).first();
    return r ? r.n : 0;
  } catch {
    return op === "count" ? 0 : undefined;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsFor(request, env);
    const moved = canonicalRedirect(request);
    if (moved) return moved;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // State-changing API calls only from the Inpriv pages. Service-to-service
    // endpoints carry the SERVICE_KEY instead and have no Origin.
    const service = path === "/api/grant/redeem" || path === "/api/totp/verify";
    if (path.startsWith("/api/") && isUnsafeMethod(request) && !service && !originAllowed(request, allowedOrigins(env))) {
      return bad("request refused: unknown origin", 403);
    }

    const gate = await maintenanceGate("account", env);
    // /api/health (monitoring) and /api/maintenance (the notice banner) answer
    // even while the site is locked.
    if (gate.locked && path !== "/api/health" && path !== "/api/maintenance") {
      return maintenancePage("Inpriv ID", gate.message);
    }

    if (path === "/api/maintenance") {
      return json({ locked: gate.locked, message: gate.message, info: gate.info }, 200);
    }

    // ── One Tap widget: /id.js — loadable from every *.inpriv.xyz page ──
    if (path === "/id.js" && request.method === "GET") {
      const res = await env.ASSETS.fetch(new URL("https://assets.local/id.js"));
      const body = await res.text();
      return withHeaders(new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      }));
    }

    // ── static frontend (login page + panel) for non-API GETs/HEADs ──
    if ((request.method === "GET" || request.method === "HEAD") && !path.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) return notFound(request, "Inpriv ID");
      return pageResponse(request, res, { "=form-action": ["'self'"] });
    }

    if (path === "/api/health") {
      // Bounded compatibility migration; no code or hash enters logs.
      await protectLegacyCodes(env);
      return json({ service: "inpriv-id", status: "ok", version: "1.1.0", release: "2026-11-09" });
    }

    try {
      // ═══ PUBLIC: REGISTER ═══
      if (path === "/api/register" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `reg:${(clientNet(request) || "unknown")}`, 5, 3_600_000)))
          return bad("too many registrations from this network — try again later", 429);

        const body = await request.json();
        let username = String(body.username || body.inpriv_id || body.email || "").toLowerCase().trim();
        const password = String(body.password || "");
        const nick = String(body.nick || "").trim().slice(0, 24);
        let recoveryEmail = String(body.recovery_email || "").toLowerCase().trim();

        // Strip domain suffix if user typed username@inpriv.xyz
        if (username.endsWith("@inpriv.xyz")) {
          username = username.slice(0, -"@inpriv.xyz".length).trim();
        }

        if (!username) return bad("please choose your Inpriv ID");
        if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
          return bad("Inpriv ID: 3-32 characters (letters, numbers, dot, dash, underscore)");
        }
        if (/^[-._]|[-._]$/.test(username) || /[._-]{2,}/.test(username)) {
          return bad("Inpriv ID cannot start/end with or contain consecutive symbols");
        }
        if (isReservedUsername(username)) {
          return bad("this Inpriv ID is reserved");
        }

        const inprivEmail = `${username}@inpriv.xyz`;

        if (recoveryEmail) {
          if (recoveryEmail.endsWith("@inpriv.xyz")) {
            return bad("recovery email must be an external address (e.g. Gmail, Proton)");
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recoveryEmail)) {
            return bad("invalid recovery email address");
          }
        } else {
          recoveryEmail = null;
        }

        if (password.length < 8) return bad("password too short (min 8 characters)");
        if (password.length > 200) return bad("password too long");
        if (nick && !/^[a-zA-Z0-9._\- ]{1,24}$/.test(nick)) return bad("nickname: 1-24 chars");

        await ensureRetired(env.DB);
        if (await env.DB.prepare("SELECT 1 FROM retired_usernames WHERE username = ?").bind(username).first()) {
          return bad("this Inpriv ID was used before and can't be registered again", 409);
        }
        // the shared address claim (common/addresses.js) is the authority;
        // the claim and the account are written in one transaction below
        await ensureClaims(env.DB);
        await backfillIdClaims(env.DB);
        if (await claimOwner(env.DB, username)) {
          return bad("this address was used before and can't be registered again", 409);
        }

        const dup = await env.DB.prepare(
          "SELECT 1 FROM users WHERE username = ? OR email = ?"
        ).bind(username, inprivEmail).first();
        if (dup) return bad("an account with this Inpriv ID or recovery email already exists", 409);

        // Never issue an ID whose @inpriv.xyz address is already delivered by
        // Inpriv Mail (mailboxes registered without an ID first).
        if (env.MAIL_DB) {
          const mailDup = await env.MAIL_DB.prepare(
            "SELECT 1 FROM users WHERE username = ? OR address = ?"
          ).bind(username, inprivEmail).first();
          if (mailDup) {
            return bad("this address is already an active mailbox — sign in on Inpriv Mail with your ID or pick another ID", 409);
          }
        }

        // Never issue an address a Temp inbox ever had (inboxes from before
        // address claims existed are only in the Temp database).
        if (env.TEMP_DB) {
          const shadow = await env.TEMP_DB
            .prepare("SELECT 1 FROM mailboxes WHERE address = ?")
            .bind(inprivEmail)
            .first();
          if (shadow) return bad("this address was used before and can't be registered again", 409);
        }

        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const ph = await passHash(password, salt);
        const uid = uuid();
        try {
          await env.DB.batch([
            claimStatement(env.DB, username, "id"),
            env.DB.prepare(
              "INSERT INTO users (id, username, email, pending_recovery_email, nick, pass_hash, pass_salt, pass_iters, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
            ).bind(uid, username, inprivEmail, recoveryEmail, nick || username, ph, salt, PASS_ITERS, now()),
          ]);
        } catch (e) {
          if (/UNIQUE|constraint/i.test(String(e && e.message))) {
            return bad("an account with this Inpriv ID or recovery email already exists", 409);
          }
          throw e;
        }
        await logEvent(env.DB, uid, "register", request);

        if (recoveryEmail) await sendRecoveryCode(env, uid);

        const s = await createSession(env.DB, uid, request, true);
        // Lets the page create the mailbox immediately. Best-effort: a failure
        // here must never fail the sign-up — Mail can be set up later.
        let mailSetupTicket = null;
        try { mailSetupTicket = await mintInitTicket(env, username); } catch { /* ignore */ }
        return json(
          { user: await publicUser(env, uid), verification_sent: false, mail_setup_ticket: mailSetupTicket },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }

      // ═══ PUBLIC: LOGIN ═══
      if (path === "/api/login" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `login:${(clientNet(request) || "unknown")}`, 10, 15 * 60_000)))
          return bad("too many attempts — wait 15 minutes", 429);

        const body = await request.json();
        let input = String(body.login || body.email || body.address || body.username || "").toLowerCase().trim();
        const password = String(body.password || "");

        let usernameCandidate = input;
        if (usernameCandidate.endsWith("@inpriv.xyz")) {
          usernameCandidate = usernameCandidate.slice(0, -"@inpriv.xyz".length).trim();
        }

        const user = await env.DB.prepare(
          `SELECT id, username, email, recovery_email, pass_hash, pass_salt, pass_iters, totp_enabled
           FROM users
           WHERE username = ? OR email = ? OR email = (? || '@inpriv.xyz') OR recovery_email = ?`
        ).bind(usernameCandidate, input, usernameCandidate, input).first();

        // Failed passwords per account, from any network: slows guessing
        // spread over many addresses. High enough that someone else can't
        // lock the owner out with a few tries.
        if (user && (await overLimit(env.DB, `loginfail:${user.id}`, 50, 3_600_000)))
          return bad("too many failed sign-ins for this account — wait an hour", 429);

        // hash even when user missing (timingEqual-ish anti-enumeration)
        const ph = await passHash(password, user ? user.pass_salt : b64(encSalt(input)), user ? user.pass_iters : PASS_ITERS);
        const okFlag = user ? constantTimeEq(ph, user.pass_hash) : false;
        if (!okFlag) {
          if (user) {
            await bump(env.DB, `loginfail:${user.id}`, 3_600_000);
            await logEvent(env.DB, user.id, "login_fail", request);
          }
          return bad("invalid credentials", 401);
        }
        await logEvent(env.DB, user.id, "login", request);

        if (user.totp_enabled) {
          const pending = newToken();
          const pid = await sha256hex(pending);
          await env.DB.prepare(
            "INSERT INTO pending_2fa (id, user_id, created_at, expires_at, ip_prefix) VALUES (?,?,?,?,?)"
          ).bind(pid, user.id, now(), now() + 5 * 60_000, ipPrefix(request)).run();
          return json({ mfa_required: true, mfa_token: pending }, 200, cors);
        }

        const s = await createSession(env.DB, user.id, request, true);
        await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), user.id).run();
        return json(
          { user: await publicUser(env, user.id, true) },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }

      // ═══ PUBLIC: 2FA LOGIN ═══
      if (path === "/api/login/2fa" && request.method === "POST") {
        const body = await request.json();
        const mfaToken = String(body.mfa_token || "");
        const code = String(body.code || "").trim();
        const recovery = String(body.recovery || "").toLowerCase().trim();
        if (!mfaToken) return bad("missing mfa session", 401);
        const pid = await sha256hex(mfaToken);
        const p = await env.DB.prepare(
          "SELECT user_id, expires_at FROM pending_2fa WHERE id = ?"
        ).bind(pid).first();
        if (!p || p.expires_at < now()) return bad("mfa session expired — start over", 401);
        // 5 tries per sign-in, 10 per account in 15 minutes: a 6-digit code
        // can't be guessed by repeating requests
        if (!(await rateLimit(env.DB, `mfa:${pid}`, 5, 5 * 60_000))) {
          await env.DB.prepare("DELETE FROM pending_2fa WHERE id = ?").bind(pid).run();
          return bad("too many wrong codes — sign in again", 401);
        }
        if (!(await rateLimit(env.DB, `mfau:${p.user_id}`, 10, 15 * 60_000)))
          return bad("too many wrong codes — wait 15 minutes", 429);

        const factor = await factorStatement(env, p.user_id, { code, recovery });
        if (!factor) return bad("invalid or already used two-factor code", 401);
        const s = await createSession(env.DB, p.user_id, request, true, factor);
        if (!s) return bad("invalid or already used two-factor code", 401);
        if (recovery) await logEvent(env.DB, p.user_id, "recovery_used", request);
        await env.DB.prepare("DELETE FROM pending_2fa WHERE id = ?").bind(pid).run();
        await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), p.user_id).run();
        return json(
          { user: await publicUser(env, p.user_id, true) },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }
      // ── service-to-service TOTP verification (sibling Inpriv workers) ──
      // verify a user's TOTP code without ever seeing the secret. Guarded by
      // a shared SERVICE_KEY secret; rate-limited per username. Never issues
      // a session — the caller keeps its own auth state.

      // ═══ QUICK SIGN-IN (SSO grants) ═══
      // One-time tickets minted by id.js on a signed-in browser and redeemed
      // server-to-server by *.inpriv.xyz backends holding the shared
      // SERVICE_KEY. Never exposes the master password or password verifier.

      // /api/grant — browser (id.js) asks for a ticket for one service.
      // Cookie/Bearer authenticated. Single use, 120-second lifetime.
      if (path === "/api/grant" && request.method === "POST") {
        const gme = await authUser(request, env, true);
        if (!gme) return bad("unauthorized", 401);
        const body = await request.json().catch(() => ({}));
        const service = String(body.service || "").toLowerCase();
        const state = String(body.state || "").slice(0, 128);
        if (!/^[a-z0-9-]{1,24}$/.test(service)) return bad("invalid service", 400);
        if (!(await rateLimit(env.DB, `grant:${gme.uid}`, 30, 60_000)))
          return bad("too many sign-in requests — slow down", 429);
        await ensureTables(env);
        const gid = newToken();
        await env.DB.prepare(
          "INSERT INTO service_grants (id, user_id, service, state, created_at, expires_at) VALUES (?,?,?,?,?,?)"
        ).bind(gid, gme.uid, service, state || "", now(), now() + 120_000).run();
        const h = { ...cors };
        if (gme.token) {
          if (gme.via === "cookie") h["Set-Cookie"] = sessionCookie(gme.token);
          else h["X-Inpriv-Token"] = gme.token;
        }
        return json({ grant: gid, state: state || "", expires_in: 120 }, 200, h);
      }

      // /api/grant/redeem — service backend (SERVICE_KEY) burns the ticket and
      // receives the identity + quick_unlock flag. TOTP users get sso: false —
      // the service must fall back to its regular password+2FA flow (a silent
      // cross-site login would otherwise bypass the second factor entirely).
      if (path === "/api/grant/redeem" && request.method === "POST") {
        if (!env.SERVICE_KEY || request.headers.get("X-Inpriv-Service") !== env.SERVICE_KEY)
          return bad("forbidden", 403);
        const body = await request.json().catch(() => ({}));
        const gid = String(body.grant || "");
        const service = String(body.service || "").toLowerCase();
        if (!gid || !service) return bad("grant and service required", 400);
        if (!(await rateLimit(env.DB, `redeem:${ipPrefix(request)}`, 60, 60_000)))
          return bad("rate limited", 429);

        await ensureTables(env);
        const g = await env.DB.prepare(
          "SELECT * FROM service_grants WHERE id = ? AND service = ?"
        ).bind(gid, service).first();
        // single-use burn (regardless of what follows, the ticket dies here)
        if (g) await env.DB.prepare("UPDATE service_grants SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now(), gid).run();
        if (!g || g.used_at || g.expires_at < now())
          return bad("grant expired or already used", 401);

        const u = await env.DB.prepare(
          "SELECT id, username, email, nick, totp_enabled FROM users WHERE id = ?"
        ).bind(g.user_id).first();
        if (!u) return bad("account not found", 404);

        const settings = await env.DB.prepare(
          "SELECT quick_unlock FROM user_settings WHERE user_id = ?"
        ).bind(u.id).first();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO consents (user_id, service, granted_at, last_used) VALUES (?,?,?,?)"
        ).bind(u.id, service, now(), now()).run();
        await logEvent(env.DB, u.id, "sso", request);

        return json({
          ok: true,
          user: {
            id: u.id,
            username: u.username,
            email: u.email,
            nick: u.nick || u.username,
          },
          state: g.state || "",
          quick_unlock: !(settings && settings.quick_unlock === 0), // no row = on, as everywhere
          totp_enabled: !!u.totp_enabled, // service must enforce 2FA fallback
        }, 200, cors);
      }

      // ═══ PRIVACY: show my address to people I write to ═══
      // Server-side on purpose (not the vault): Inpriv Mail has to act on it
      // when it stores a message, and it can only read columns it can see.
      if (path === "/api/privacy" && request.method === "POST") {
        const pme = await authUser(request, env, true);
        if (!pme) return bad("unauthorized", 401);
        const pb = await request.json().catch(() => ({}));
        const show = typeof pb.show_address === "boolean" ? pb.show_address : null;
        const suggest = typeof pb.suggest_address === "boolean" ? pb.suggest_address : null;
        if (show === null && suggest === null) {
          return bad("show_address or suggest_address (boolean) required", 400);
        }
        // Stored independently; the mail worker only offers an address when
        // both are on, so turning one off is enough to hide it.
        const sets = [], binds = [], actions = [];
        if (show !== null) { sets.push("show_address = ?"); binds.push(show ? 1 : 0); actions.push(show ? "show_address_on" : "show_address_off"); }
        if (suggest !== null) { sets.push("suggest_address = ?"); binds.push(suggest ? 1 : 0); actions.push(suggest ? "suggest_address_on" : "suggest_address_off"); }
        await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, pme.uid).run();
        for (const action of actions) await logEvent(env.DB, pme.uid, action, request);
        const row = await env.DB.prepare("SELECT show_address, suggest_address FROM users WHERE id = ?").bind(pme.uid).first();
        return json({ ok: true, show_address: row.show_address === 1, suggest_address: row.suggest_address === 1 }, 200, cors);
      }

      // ═══ MAILBOX READY? (asked right after sign-up) ═══
      // The page hands the sealed key envelope to Inpriv Mail, then asks this
      // to confirm; ID only reads Mail's database, it never writes a mailbox.
      if (path === "/api/mailbox/status" && request.method === "GET") {
        const mme = await authUser(request, env, true);
        if (!mme) return bad("unauthorized", 401);
        let ready = false;
        try {
          const u = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(mme.uid).first();
          if (u && env.MAIL_DB) {
            const row = await env.MAIL_DB.prepare(
              "SELECT 1 FROM users WHERE username = ? AND public_key IS NOT NULL AND public_key != ''"
            ).bind(u.username).first();
            ready = !!row;
          }
        } catch { ready = false; }
        return json({ ready }, 200, cors);
      }

      // ═══ ACCOUNT SETTINGS (quick unlock toggle) ═══
      if (path === "/api/settings" && request.method === "GET") {
        const sme = await authUser(request, env, true);
        if (!sme) return bad("unauthorized", 401);
        await ensureTables(env);
        const s = await env.DB.prepare("SELECT quick_unlock FROM user_settings WHERE user_id = ?").bind(sme.uid).first();
        const devices = await mailDeviceKeys(env, sme.uid, "count");
        const h = { ...cors };
        if (sme.token) {
          if (sme.via === "cookie") h["Set-Cookie"] = sessionCookie(sme.token);
          else h["X-Inpriv-Token"] = sme.token;
        }
        return json({ settings: { quick_unlock: !(s && s.quick_unlock === 0), devices } }, 200, h);
      }
      if (path === "/api/settings" && request.method === "POST") {
        const sme = await authUser(request, env, true);
        if (!sme) return bad("unauthorized", 401);
        const body = await request.json().catch(() => ({}));
        if (typeof body.quick_unlock !== "boolean") return bad("quick_unlock (boolean) required", 400);
        await ensureTables(env);
        await env.DB.prepare(
          "INSERT INTO user_settings (user_id, quick_unlock, updated_at) VALUES (?,?,?) " +
          "ON CONFLICT(user_id) DO UPDATE SET quick_unlock = excluded.quick_unlock, updated_at = excluded.updated_at"
        ).bind(sme.uid, body.quick_unlock ? 1 : 0, now()).run();
        if (!body.quick_unlock) {
          // off means off everywhere: no device keeps a key it could reuse
          // when the switch is turned back on
          await env.DB.prepare("DELETE FROM quick_unlock WHERE user_id = ?").bind(sme.uid).run();
          await mailDeviceKeys(env, sme.uid, "clear");
        }
        const h = { ...cors };
        if (sme.token) {
          if (sme.via === "cookie") h["Set-Cookie"] = sessionCookie(sme.token);
          else h["X-Inpriv-Token"] = sme.token;
        }
        return json({ ok: true, settings: { quick_unlock: body.quick_unlock } }, 200, h);
      }

      // ═══ CONNECTED SERVICES (Quick Sign-In) ═══
      // Every service that redeems SSO grants, with this account's consent
      // state from the consents table (written on each grant redemption).
      if (path === "/api/services" && request.method === "GET") {
        const svcMe = await authUser(request, env, true);
        if (!svcMe) return bad("unauthorized", 401);
        await ensureTables(env);
        const rows = await env.DB.prepare(
          "SELECT service, granted_at, last_used FROM consents WHERE user_id = ?"
        ).bind(svcMe.uid).all();
        const bySrv = new Map(rows.results.map((r) => [r.service, r]));
        const services = Object.entries(SERVICE_META).map(([id, meta]) => {
          const c = bySrv.get(id);
          return {
            id,
            ...meta,
            connected: !!c,
            granted_at: c ? c.granted_at : null,
            last_used: c ? (c.last_used || c.granted_at) : null,
          };
        });
        const sh = { ...cors };
        if (svcMe.token) {
          if (svcMe.via === "cookie") sh["Set-Cookie"] = sessionCookie(svcMe.token);
          else sh["X-Inpriv-Token"] = svcMe.token;
        }
        return json({ services }, 200, sh);
      }

      // ═══ QUICK UNLOCK WRAPPED KEYS (master-password bypass storage) ═══
      // The device key never leaves the browser: the page wraps its local DEK
      // under the RSA public key of the signed-in user and stores the opaque
      // blob here. Only an authenticated browser with the matching device key
      // can decrypt it — the server sees ciphertext either way.
      if (path === "/api/quick-unlock/get" && request.method === "GET") {
        const qme = await authUser(request, env, true);
        if (!qme) return bad("unauthorized", 401);
        await ensureTables(env);
        const s = await env.DB.prepare("SELECT quick_unlock FROM user_settings WHERE user_id = ?").bind(qme.uid).first();
        if (s && s.quick_unlock === 0) return bad("quick unlock disabled on this account", 403);
        const r = await env.DB.prepare("SELECT blob FROM quick_unlock WHERE user_id = ?").bind(qme.uid).first();
        const h = { ...cors };
        if (qme.token) {
          if (qme.via === "cookie") h["Set-Cookie"] = sessionCookie(qme.token);
          else h["X-Inpriv-Token"] = qme.token;
        }
        return json({ blob: r ? r.blob : null }, 200, h);
      }
      if (path === "/api/quick-unlock/set" && request.method === "POST") {
        const qme = await authUser(request, env, true);
        if (!qme) return bad("unauthorized", 401);
        const body = await request.json().catch(() => ({}));
        const blob = typeof body.blob === "string" ? body.blob : "";
        if (!blob) return bad("blob required", 400);
        if (blob.length > 12_000) return bad("blob too large", 413);
        await ensureTables(env);
        const s = await env.DB.prepare("SELECT quick_unlock FROM user_settings WHERE user_id = ?").bind(qme.uid).first();
        if (s && s.quick_unlock === 0) return bad("quick unlock disabled on this account", 403);
        await env.DB.prepare(
          "INSERT INTO quick_unlock (user_id, blob, updated_at) VALUES (?,?,?) " +
          "ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at"
        ).bind(qme.uid, blob, now()).run();
        const h = { ...cors };
        if (qme.token) {
          if (qme.via === "cookie") h["Set-Cookie"] = sessionCookie(qme.token);
          else h["X-Inpriv-Token"] = qme.token;
        }
        return json({ ok: true }, 200, h);
      }
      if (path === "/api/quick-unlock/clear" && request.method === "POST") {
        const cme = await authUser(request, env, true);
        if (!cme) return bad("unauthorized", 401);
        await ensureTables(env);
        await env.DB.prepare("DELETE FROM quick_unlock WHERE user_id = ?").bind(cme.uid).run();
        const h = { ...cors };
        if (cme.token) {
          if (cme.via === "cookie") h["Set-Cookie"] = sessionCookie(cme.token);
          else h["X-Inpriv-Token"] = cme.token;
        }
        return json({ ok: true }, 200, h);
      }

      if (path === "/api/totp/verify" && request.method === "POST") {
        if (!env.SERVICE_KEY || request.headers.get("X-Inpriv-Service") !== env.SERVICE_KEY)
          return bad("forbidden", 403);
        const body = await request.json().catch(() => ({}));
        const uname = String(body.username || "").toLowerCase().split("@")[0];
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code) && !body.recovery) return bad("invalid code", 400);
        if (!uname) return bad("invalid username", 400);
        if (!(await rateLimit(env.DB, `tverify:${uname}`, 10, 10 * 60_000)))
          return bad("too many attempts — try again in 10 minutes", 429);
        const u = await env.DB.prepare(
          "SELECT id FROM users WHERE username = ? OR email = ?"
        ).bind(uname, uname + "@inpriv.xyz").first();
        if (!u) return json({ ok: false }, 200, cors); // anti-enumeration: same shape
        const okFlag = await consumeFactor(env, u.id, body);
        return json({ ok: okFlag }, 200, cors);
      }


      // ═══ SESSION-SCOPED ═══
      const me = await authUser(request, env, true);

      // central responder: carries the rotated token (header for Bearer
      // clients, Set-Cookie for cookie sessions) so rotation never orphans
      // the legitimate client
      const out = (body, status = 200, extra = {}) => {
        const h = { ...cors, ...extra };
        if (me && me.token) {
          if (me.via === "cookie") h["Set-Cookie"] = sessionCookie(me.token);
          else h["X-Inpriv-Token"] = me.token;
        }
        return json(body, status, h);
      };

      if (path === "/api/logout" && request.method === "POST") {
        if (me) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(me.row.sid).run();
        return out({ ok: true }, 200, { ...cors, "Set-Cookie": clearCookie() });
      }

      if (path === "/api/public/me" && request.method === "GET") {
        if (!me) return out({ user: null }, 200, cors);
        const pub = await publicUser(env, me.uid);
        // quick_unlock drives the cross-service master-password bypass. It
        // only skips the master password after a full sign-in (which already
        // asked for the 2FA code), so 2FA accounts get the real setting too —
        // otherwise Mail and this page would disagree about the switch.
        try {
          await ensureTables(env);
          const st = await env.DB.prepare("SELECT quick_unlock FROM user_settings WHERE user_id = ?").bind(me.uid).first();
          pub.quick_unlock = !(st && st.quick_unlock === 0);
        } catch { pub.quick_unlock = true; }
        return out({ user: pub }, 200, cors);
      }

      if (!me) return bad("unauthorized", 401);

      if (path === "/api/me" && request.method === "GET") {
        return out({ user: await publicUser(env, me.uid, true) }, 200, cors);
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

      // ── e-mail verification (recovery email) ──
      if (path === "/api/verify/send" && request.method === "POST") {
        const r = await sendRecoveryCode(env, me.uid);
        if (!r.ok) return out({ error: r.error }, r.status, cors);
        return out({ ok: true, already: !!r.already }, 200, cors);
      }
      if (path === "/api/verify/confirm" && request.method === "POST") {
        const body = await request.json();
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code)) return bad("enter the 6-digit code");
        if (!(await rateLimit(env.DB, `vconfirm:${me.uid}`, 8, 15 * 60_000))) {
          return bad("too many tries — wait 15 minutes, then ask for a new code", 429);
        }
        const address = (await env.DB.prepare("SELECT COALESCE(pending_recovery_email, recovery_email) AS email FROM users WHERE id = ?").bind(me.uid).first()).email;
        const row = await env.DB.prepare("SELECT id, code_hash, expires_at, used_at FROM email_codes WHERE user_id = ? AND purpose = 'verify' ORDER BY expires_at DESC LIMIT 1").bind(me.uid).first();
        if (!row || row.used_at || row.expires_at < now() || !(await codeMatches(env, address + "\0" + code, row.code_hash))) return bad("invalid or expired code", 401);
        try {
          const result = await env.DB.batch([
            env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND COALESCE(pending_recovery_email, recovery_email) = ?)").bind(now(), row.id, me.uid, address),
            env.DB.prepare("UPDATE users SET recovery_email = ?, pending_recovery_email = NULL, recovery_email_verified = 1, email_verified = 1 WHERE id = ? AND changes() = 1").bind(address, me.uid),
          ]);
          if (result[1].meta.changes !== 1) return bad("invalid or expired code", 401);
        } catch (error) {
          if (/UNIQUE|constraint/i.test(String(error.message))) return bad("this address is already confirmed on another account", 409);
          throw error;
        }
        return out({ ok: true, user: await publicUser(env, me.uid, true) }, 200, cors);
      }

      // ── update recovery email ──
      if (path === "/api/recovery-email/set" && request.method === "POST") {
        const body = await request.json();
        let recoveryEmail = String(body.recovery_email || "").toLowerCase().trim();
        if (recoveryEmail) {
          if (recoveryEmail.endsWith("@inpriv.xyz")) {
            return bad("recovery email must be an external address");
          }
          if (recoveryEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recoveryEmail)) {
            return bad("invalid recovery email address");
          }
        } else {
          recoveryEmail = null;
        }
        const cur = await env.DB.prepare("SELECT COALESCE(pending_recovery_email, recovery_email) AS recovery_email, CASE WHEN pending_recovery_email IS NULL THEN recovery_email_verified ELSE 0 END AS recovery_email_verified FROM users WHERE id = ?").bind(me.uid).first();
        // same address again: keep its status; if it's still waiting, send a fresh code
        if ((cur.recovery_email || null) === recoveryEmail) {
          if (!recoveryEmail || cur.recovery_email_verified) {
            return out({ ok: true, user: await publicUser(env, me.uid, true), code_sent: false }, 200, cors);
          }
          const r = await sendRecoveryCode(env, me.uid);
          if (!r.ok) return out({ error: r.error }, r.status, cors);
          return out({ ok: true, user: await publicUser(env, me.uid, true), code_sent: true }, 200, cors);
        }
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET pending_recovery_email = ?, recovery_email = CASE WHEN ? IS NULL THEN NULL ELSE recovery_email END, recovery_email_verified = CASE WHEN ? IS NULL THEN 0 ELSE recovery_email_verified END, email_verified = CASE WHEN ? IS NULL THEN 0 ELSE email_verified END WHERE id = ?")
            .bind(recoveryEmail, recoveryEmail, recoveryEmail, recoveryEmail, me.uid),
          env.DB.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").bind(me.uid),
        ]);
        await logEvent(env.DB, me.uid, recoveryEmail ? "recovery_set" : "recovery_removed", request);
        if (!recoveryEmail) return out({ ok: true, user: await publicUser(env, me.uid, true), code_sent: false }, 200, cors);
        const r = await sendRecoveryCode(env, me.uid);
        return out({ ok: true, user: await publicUser(env, me.uid, true), code_sent: r.ok, error: r.ok ? undefined : r.error }, 200, cors);
      }

      if (path === "/api/2fa/setup" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `tsetup:${me.uid}`, 5, 3_600_000))) return bad("try again later", 429);
        // replacing a working secret needs the password (via 2FA off first);
        // a session alone must not be able to swap or break it
        if (me.row.totp_enabled) return bad("two-factor is already on — turn it off first to set it up again", 409);
        const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
        const urow = await env.DB.prepare("SELECT email, username FROM users WHERE id = ?").bind(me.uid).first();
        const accountLabel = urow.username ? `${urow.username}@inpriv.xyz` : (urow.email || "user@inpriv.xyz");
        const otpauth = `otpauth://totp/Inpriv:${encodeURIComponent(accountLabel)}?secret=${secret}&issuer=Inpriv&algorithm=SHA1&digits=6&period=30`;
        await env.DB.prepare(
          "INSERT INTO totp_secrets (user_id, secret_enc, confirmed, created_at) VALUES (?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, confirmed = 0, last_step = NULL"
        ).bind(me.uid, await sealString(env, secret), now()).run();
        // the page draws the QR code itself; the secret never goes to another service
        return out({ secret, otpauth }, 200, cors);
      }
      if (path === "/api/2fa/confirm" && request.method === "POST") {
        const body = await request.json();
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code)) return bad("enter the 6-digit code");
        if (me.row.totp_enabled) return bad("two-factor is already on", 409);
        if (!(await rateLimit(env.DB, `tconfirm:${me.uid}`, 10, 15 * 60_000))) return bad("too many tries — wait 15 minutes", 429);
        if (!(await consumeFactor(env, me.uid, body, true))) return bad("invalid or already used code — try the next one", 401);
        const codes = [];
        const stmts = [];
        for (let i = 0; i < 10; i++) {
          const raw = newToken().slice(0, 4) + "-" + newToken().slice(0, 4);
          codes.push(raw);
          stmts.push(env.DB.prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?,?,?)")
            .bind(uuid(), me.uid, await protectCode(env, raw.toLowerCase())));
        }
        stmts.push(env.DB.prepare("UPDATE totp_secrets SET confirmed = 1 WHERE user_id = ?").bind(me.uid));
        stmts.push(env.DB.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").bind(me.uid));
        stmts.push(env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ? AND used_at IS NOT NULL").bind(me.uid));
        // sessions opened without the second factor end here
        stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.uid, me.row.sid));
        await env.DB.batch(stmts);
        await revokeMailSessions(env, me.uid);
        await logEvent(env.DB, me.uid, "totp_on", request);
        return out({ ok: true, recovery_codes: codes }, 200, cors);
      }
      // Recovery codes are stored hashed, so they can't be shown again; this
      // replaces them with 10 new ones (shown once) after a password check.
      if (path === "/api/2fa/recovery" && request.method === "GET") {
        const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(me.uid).first();
        return out({ remaining: r ? r.n : 0 }, 200, cors);
      }
      if (path === "/api/2fa/recovery/new" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `rcnew:${me.uid}`, 5, 3_600_000))) return bad("try again later", 429);
        const body = await request.json().catch(() => ({}));
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters, totp_enabled FROM users WHERE id = ?").bind(me.uid).first();
        if (!u.totp_enabled) return bad("turn on 2FA first", 400);
        if (!(await rateLimit(env.DB, `pwcheck:${me.uid}`, 10, 3_600_000))) return bad("too many tries — wait an hour", 429);
        const candidate = await passHash(String(body.password || ""), u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("wrong password", 401);
        if (me.row.totp_enabled && !(await consumeFactor(env, me.uid, body)))
          return bad("enter a fresh two-factor code or an unused recovery code", 401);
        const codes = [];
        const stmts = [env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(me.uid)];
        for (let i = 0; i < 10; i++) {
          const raw = newToken().slice(0, 4) + "-" + newToken().slice(0, 4);
          codes.push(raw);
          stmts.push(env.DB.prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?,?,?)")
            .bind(uuid(), me.uid, await protectCode(env, raw.toLowerCase())));
        }
        await env.DB.batch(stmts);
        await logEvent(env.DB, me.uid, "recovery_new", request);
        return out({ ok: true, recovery_codes: codes }, 200, cors);
      }
      if (path === "/api/2fa/disable" && request.method === "POST") {
        const body = await request.json();
        if (!(await rateLimit(env.DB, `pwcheck:${me.uid}`, 10, 3_600_000))) return bad("too many tries — wait an hour", 429);
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters FROM users WHERE id = ?").bind(me.uid).first();
        const candidate = await passHash(String(body.password || ""), u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("wrong password", 401);
        if (me.row.totp_enabled && !(await consumeFactor(env, me.uid, body)))
          return bad("enter a fresh two-factor code or an unused recovery code", 401);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM totp_secrets WHERE user_id = ?").bind(me.uid),
          env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(me.uid),
          env.DB.prepare("UPDATE users SET totp_enabled = 0 WHERE id = ?").bind(me.uid),
        ]);
        await revokeMailSessions(env, me.uid);
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
        await revokeMailSessions(env, me.uid);
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
        if (nick && !/^[a-zA-Z0-9._\- ]{1,24}$/.test(nick)) return bad("nickname: 1-24 chars, letters/digits/._-");
        await env.DB.prepare("UPDATE users SET nick = ? WHERE id = ?").bind(nick || null, me.uid).run();
        return out({ ok: true, user: await publicUser(env, me.uid, true) }, 200, cors);
      }

      // ── password change ──
      if (path === "/api/password/change" && request.method === "POST") {
        const body = await request.json();
        const current = String(body.current || "");
        const next = String(body.next || "");
        if (next.length < 8) return bad("new password too short (min 8)");
        if (next.length > 200) return bad("new password too long");
        if (!(await rateLimit(env.DB, `pwchange:${me.uid}`, 10, 3_600_000))) return bad("too many tries — wait an hour", 429);
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters FROM users WHERE id = ?").bind(me.uid).first();
        const candidate = await passHash(current, u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("current password is wrong", 401);
        if (me.row.totp_enabled && !(await consumeFactor(env, me.uid, body)))
          return bad("enter a fresh two-factor code or an unused recovery code", 401);
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const ph = await passHash(next, salt);
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iters = ? WHERE id = ?")
            .bind(ph, salt, PASS_ITERS, me.uid),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.uid, me.row.sid),
        ]);
        // Mail sessions end too. The mailbox passphrase is separate from this
        // password and doesn't change.
        await revokeMailSessions(env, me.uid);
        await logEvent(env.DB, me.uid, "pass_change", request);
        return out({ ok: true }, 200, cors);
      }

      // ── account deletion ──
      if (path === "/api/account/delete" && request.method === "POST") {
        const body = await request.json();
        if (!(await rateLimit(env.DB, `pwcheck:${me.uid}`, 10, 3_600_000))) return bad("too many tries — wait an hour", 429);
        const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iters FROM users WHERE id = ?").bind(me.uid).first();
        const candidate = await passHash(String(body.password || ""), u.pass_salt, u.pass_iters);
        if (!constantTimeEq(candidate, u.pass_hash)) return bad("wrong password", 401);
        if (me.row.totp_enabled && !(await consumeFactor(env, me.uid, body)))
          return bad("enter a fresh two-factor code or an unused recovery code", 401);
        const gone = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(me.uid).first();
        await env.DB.batch([
          env.DB.prepare("DELETE FROM access_log WHERE account IN (?, ?)").bind(gone?.username || me.uid, me.uid),
          env.DB.prepare("DELETE FROM auth_events WHERE user_id = ?").bind(me.uid),
          env.DB.prepare("DELETE FROM users WHERE id = ?").bind(me.uid),
        ]);
        if (gone && gone.username) {
          // the address is never handed to anyone else (mail meant for the old
          // owner must not reach a new one): its address claim stays, and the
          // name is retired. The mailbox goes with the ID: keys, messages,
          // sessions and device keys (ON DELETE CASCADE)
          await ensureRetired(env.DB);
          await env.DB.prepare("INSERT OR IGNORE INTO retired_usernames (username, retired_at) VALUES (?, ?)")
            .bind(gone.username, now()).run();
          if (env.MAIL_DB) {
            await env.MAIL_DB.prepare("DELETE FROM users WHERE username = ?").bind(gone.username).run();
          }
        }
        return out({ ok: true }, 200, { ...cors, "Set-Cookie": clearCookie() });
      }

      return bad("not found", 404);
    } catch (e) {
      // details go to the Worker log, not to the caller
      console.error("id api error", path, e && e.message);
      return json({ error: "server error" }, 500);
    }
  },
};

// deterministic fake salt for anti-enumeration timing (never used for login)
function encSalt(email) {
  const e = new TextEncoder().encode("pepper:" + email);
  return b64(e.subarray(0, 16));
}

async function protectLegacyCodes(env) {
  for (const table of ["recovery_codes", "email_codes"]) {
    const rows = await env.DB.prepare(`SELECT id, code_hash FROM ${table} WHERE code_hash NOT LIKE 'sealed:%' AND code_hash NOT LIKE 'legacy-sealed:%' LIMIT 100`).all();
    if (rows.results.length) await env.DB.batch(await Promise.all(rows.results.map(async (row) => env.DB.prepare(
      `UPDATE ${table} SET code_hash = ? WHERE id = ? AND code_hash = ?`
    ).bind("legacy-sealed:" + await sealString(env, row.code_hash), row.id, row.code_hash))));
  }
}
