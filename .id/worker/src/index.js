// Inpriv ID — API router (id.inpriv.xyz).
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

// Services that redeem Quick Sign-In grants (data-service ids). Shown in the
// Privacy tab under "Connected services" with their consent state.
const SERVICE_META = {
  mail: { name: "Inpriv Mail", icon: "mark_email_unread", url: "https://mail.inpriv.xyz" },
  host: { name: "Inpriv Host", icon: "cloud_upload", url: "https://host.inpriv.xyz" },
};

async function publicUser(env, uid, full = false) {
  const u = await env.DB.prepare(
    "SELECT id, username, email, recovery_email, nick, email_verified, recovery_email_verified, totp_enabled, created_at, last_login FROM users WHERE id = ?"
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
  };
  if (full) {
    out.recovery_email = u.recovery_email || null;
    out.recovery_email_verified = !!u.recovery_email_verified;
    out.created_at = u.created_at;
    out.last_login = u.last_login;
  }
  return out;
}

// Lazy table creation: the SSO/settings tables ship after the initial
// deploy, so every endpoint that touches them calls this first. D1 keeps the
// DDL cached; the "already exists" case is a cheap no-op.
let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  // D1 runs batches inside a transaction; SQLite cannot run some DDL there,
  // so create the tables one by one (no-op once they exist).
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS service_grants (
       id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       service TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL, used_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_grants_user ON service_grants(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS user_settings (
       user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       quick_unlock INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS quick_unlock (
       user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       blob TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS consents (
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       service TEXT NOT NULL, granted_at INTEGER NOT NULL, last_used INTEGER,
       PRIMARY KEY (user_id, service))`,
  ]) {
    await env.DB.prepare(ddl).run();
  }
  tablesReady = true;
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
  } else {
    await env.DB.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").bind(now(), row.sid).run();
  }
  return { row, token, uid: row.uid, via };
}

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "inpriv", "aurex", "aurexlabs",
  "support", "security", "abuse", "postmaster", "noreply", "no-reply",
  "mailer-daemon", "help", "hello", "hi", "info", "contact", "team", "staff",
  "account", "accounts", "billing", "invoice", "payments", "sales", "legal",
  "mail", "temp", "burn", "zero", "api", "auth", "login", "signin", "signup",
  "register", "dashboard", "status", "bot", "anonymous", "null", "undefined",
  "webmaster", "hostmaster", "feedback", "welcome", "office", "priva", "priv",
  "owner", "moderator", "mod", "service", "services", "dev", "devs", "sysop",
  "operator", "everyone", "users", "member", "members", "me", "self", "user"
]);

// Prefixes that must never introduce an @inpriv.xyz address — blocks
// "admin123", "hello-world", "support-team" etc., not just exact matches.
// Long prefixes (≥4 chars) block ANY continuation; short ones (mod, me, hi,
// pop, mx, www, ftp, vpn, dev) only block separator/digit continuations, so
// "mode" or "metal" stay available.
const RESERVED_PREFIXES = [
  "abuse", "account", "admin", "administrator", "alert", "api", "aurex",
  "auth", "backup", "billing", "bot", "burn", "cert", "cluster", "contact",
  "demo", "dev", "dns", "do-not-reply", "donotreply", "everyone", "example",
  "feedback", "ftp", "gateway", "guest", "hello", "help", "hi", "hostmaster",
  "info", "inpriv", "invoice", "legal", "login", "mail", "mailer", "master",
  "me", "member", "mod", "moderator", "mx", "news", "newsletter", "noreply",
  "no-reply", "no_reply", "notify", "official", "office", "operator", "owner",
  "payment", "pop", "portal", "postmaster", "priv", "private", "public",
  "register", "root", "sales", "sample", "secure", "security", "self",
  "server", "service", "signin", "signup", "smtp", "ssl", "staff", "status",
  "support", "sysop", "team", "temp", "test", "tls", "user", "vpn", "webmaster",
  "welcome", "www", "zero"
];

function isReservedUsername(username) {
  if (RESERVED_USERNAMES.has(username)) return true;
  for (const p of RESERVED_PREFIXES) {
    if (!username.startsWith(p)) continue;
    if (username === p) return true;
    // long prefixes (admin, hello, support…) block ANY continuation
    if (p.length >= 4) return true;
    // short prefixes (mod, me, hi…) only when followed by a separator or
    // digit — blocks "mod-team" / "hi123" without blocking "mode", "metal"
    const next = username[p.length];
    if (next === "-" || next === "." || next === "_" || (next >= "0" && next <= "9")) return true;
  }
  return false;
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

    // ── static frontend (login page + panel) for non-API GETs/HEADs ──
    if ((request.method === "GET" || request.method === "HEAD") && !path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (path === "/api/health") {
      return json({ service: "inpriv-id", status: "ok", version: "1.1.0" });
    }

    try {
      // ═══ PUBLIC: REGISTER ═══
      if (path === "/api/register" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `reg:${ipPrefix(request)}`, 5, 3_600_000)))
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

        if (password.length < 10) return bad("password too short (min 10 characters)");
        if (password.length > 200) return bad("password too long");
        if (nick && !/^[a-zA-Z0-9._\- ]{1,24}$/.test(nick)) return bad("nickname: 1-24 chars");

        const dup = await env.DB.prepare(
          "SELECT 1 FROM users WHERE username = ? OR email = ? OR (recovery_email IS NOT NULL AND recovery_email = ?)"
        ).bind(username, inprivEmail, recoveryEmail || "__none__").first();
        if (dup) return bad("an account with this Inpriv ID or recovery email already exists", 409);

        // Never issue an address that a live Inpriv Temp mailbox could intercept.
        if (env.TEMP_DB) {
          const shadow = await env.TEMP_DB
            .prepare("SELECT 1 FROM mailboxes WHERE address = ? AND expires_at > ?")
            .bind(inprivEmail, now())
            .first();
          if (shadow) return bad("this address is currently in use — try again later", 409);
        }

        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const ph = await passHash(password, salt);
        const uid = uuid();
        await env.DB.prepare(
          "INSERT INTO users (id, username, email, recovery_email, nick, pass_hash, pass_salt, pass_iters, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(uid, username, inprivEmail, recoveryEmail, nick || username, ph, salt, PASS_ITERS, now()).run();
        await logEvent(env.DB, uid, "register", request);

        let sentOk = false;
        if (recoveryEmail) {
          const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
          await env.DB.prepare(
            "INSERT INTO email_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?,?,?,?,?)"
          ).bind(uuid(), uid, await sha256hex(code), "verify", now() + 15 * 60_000).run();
          const sent = await sendMail(
            env, recoveryEmail,
            "Confirm your Inpriv recovery email",
            `Your Inpriv ID: ${inprivEmail}\n\nVerification code: ${code}\n\nIt expires in 15 minutes.`,
            emailShell("Confirm your recovery email",
              `Your Inpriv ID: <strong>${inprivEmail}</strong><br><br>Enter this code to verify your recovery email:${codeBlock(code)}Expires in 15 minutes.`)
          );
          sentOk = sent.ok;
        }

        const s = await createSession(env.DB, uid, request, true);
        return json(
          { token: s.token, user: await publicUser(env, uid, true), verification_sent: sentOk },
          200,
          { ...cors, "Set-Cookie": sessionCookie(s.token) }
        );
      }

      // ═══ PUBLIC: LOGIN ═══
      if (path === "/api/login" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `login:${ipPrefix(request)}`, 10, 15 * 60_000)))
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

        // hash even when user missing (timingEqual-ish anti-enumeration)
        const ph = await passHash(password, user ? user.pass_salt : b64(encSalt(input)), user ? user.pass_iters : PASS_ITERS);
        const okFlag = user ? constantTimeEq(ph, user.pass_hash) : false;
        if (!okFlag) {
          if (user) await logEvent(env.DB, user.id, "login_fail", request);
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
          { token: s.token, user: await publicUser(env, user.id, true) },
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

        if (recovery) {
          const hash = await sha256hex(recovery);
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
          h["X-Inpriv-Token"] = gme.token;
          if (gme.via === "cookie") h["Set-Cookie"] = sessionCookie(gme.token);
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
          quick_unlock: !!(settings && settings.quick_unlock === 1),
          totp_enabled: !!u.totp_enabled, // service must enforce 2FA fallback
        }, 200, cors);
      }

      // ═══ ACCOUNT SETTINGS (quick unlock toggle) ═══
      if (path === "/api/settings" && request.method === "GET") {
        const sme = await authUser(request, env, true);
        if (!sme) return bad("unauthorized", 401);
        await ensureTables(env);
        const s = await env.DB.prepare("SELECT quick_unlock FROM user_settings WHERE user_id = ?").bind(sme.uid).first();
        const h = { ...cors };
        if (sme.token) {
          h["X-Inpriv-Token"] = sme.token;
          if (sme.via === "cookie") h["Set-Cookie"] = sessionCookie(sme.token);
        }
        return json({ settings: { quick_unlock: !(s && s.quick_unlock === 0) } }, 200, h);
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
        const h = { ...cors };
        if (sme.token) {
          h["X-Inpriv-Token"] = sme.token;
          if (sme.via === "cookie") h["Set-Cookie"] = sessionCookie(sme.token);
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
          sh["X-Inpriv-Token"] = svcMe.token;
          if (svcMe.via === "cookie") sh["Set-Cookie"] = sessionCookie(svcMe.token);
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
          h["X-Inpriv-Token"] = qme.token;
          if (qme.via === "cookie") h["Set-Cookie"] = sessionCookie(qme.token);
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
          h["X-Inpriv-Token"] = qme.token;
          if (qme.via === "cookie") h["Set-Cookie"] = sessionCookie(qme.token);
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
          h["X-Inpriv-Token"] = cme.token;
          if (cme.via === "cookie") h["Set-Cookie"] = sessionCookie(cme.token);
        }
        return json({ ok: true }, 200, h);
      }

      if (path === "/api/totp/verify" && request.method === "POST") {
        if (!env.SERVICE_KEY || request.headers.get("X-Inpriv-Service") !== env.SERVICE_KEY)
          return bad("forbidden", 403);
        const body = await request.json().catch(() => ({}));
        const uname = String(body.username || "").toLowerCase().split("@")[0];
        const code = String(body.code || "").trim();
        if (!/^\d{6}$/.test(code)) return bad("invalid code", 400);
        if (!uname) return bad("invalid username", 400);
        if (!(await rateLimit(env.DB, `tverify:${uname}`, 10, 10 * 60_000)))
          return bad("too many attempts — try again in 10 minutes", 429);
        const u = await env.DB.prepare(
          "SELECT id FROM users WHERE username = ? OR email = ?"
        ).bind(uname, uname + "@inpriv.xyz").first();
        if (!u) return json({ ok: false }, 200, cors); // anti-enumeration: same shape
        const trow = await env.DB.prepare(
          "SELECT secret_enc FROM totp_secrets WHERE user_id = ? AND confirmed = 1"
        ).bind(u.id).first();
        const secret = trow ? await openString(env, trow.secret_enc) : null;
        const okFlag = !!(secret && (await verifyTOTP(code, base32Decode(secret), now())));
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
        const pub = await publicUser(env, me.uid);
        // quick_unlock drives the cross-service master-password bypass;
        // TOTP users always see false (second factor can never be skipped)
        try {
          await ensureTables(env);
          const st = await env.DB.prepare("SELECT quick_unlock FROM user_settings WHERE user_id = ?").bind(me.uid).first();
          pub.quick_unlock = pub.totp_enabled ? false : !(st && st.quick_unlock === 0);
        } catch { pub.quick_unlock = !pub.totp_enabled; }
        return out({ user: pub }, 200, cors);
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

      // ── e-mail verification (recovery email) ──
      if (path === "/api/verify/send" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `verify:${me.uid}`, 5, 3_600_000))) return bad("limit reached — try again in an hour", 429);
        const user = await env.DB.prepare("SELECT email, recovery_email, recovery_email_verified FROM users WHERE id = ?").bind(me.uid).first();
        const targetEmail = user.recovery_email;
        if (!targetEmail) return bad("no recovery email configured", 400);
        if (user.recovery_email_verified) return out({ ok: true, already: true }, 200, cors);
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
        await env.DB.prepare("INSERT INTO email_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?,?,?,?,?)"
        ).bind(uuid(), me.uid, await sha256hex(code), "verify", now() + 15 * 60_000).run();
        const sent = await sendMail(env, targetEmail, "Your Inpriv verification code",
          `Code: ${code}`, emailShell("Verify your recovery email", `Your Inpriv account recovery verification code:${codeBlock(code)}Expires in 15 minutes.`));
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
          env.DB.prepare("UPDATE users SET recovery_email_verified = 1, email_verified = 1 WHERE id = ?").bind(me.uid),
        ]);
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
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recoveryEmail)) {
            return bad("invalid recovery email address");
          }
        } else {
          recoveryEmail = null;
        }
        await env.DB.prepare("UPDATE users SET recovery_email = ?, recovery_email_verified = 0 WHERE id = ?")
          .bind(recoveryEmail, me.uid).run();
        return out({ ok: true, user: await publicUser(env, me.uid, true) }, 200, cors);
      }


      if (path === "/api/2fa/setup" && request.method === "POST") {
        if (!(await rateLimit(env.DB, `tsetup:${me.uid}`, 5, 3_600_000))) return bad("try again later", 429);
        const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
        const urow = await env.DB.prepare("SELECT email, username FROM users WHERE id = ?").bind(me.uid).first();
        const accountLabel = urow.username ? `${urow.username}@inpriv.xyz` : (urow.email || "user@inpriv.xyz");
        const otpauth = `otpauth://totp/Inpriv:${encodeURIComponent(accountLabel)}?secret=${secret}&issuer=Inpriv&algorithm=SHA1&digits=6&period=30`;
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
        if (nick && !/^[a-zA-Z0-9._\- ]{1,24}$/.test(nick)) return bad("nickname: 1-24 chars, letters/digits/._-");
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
