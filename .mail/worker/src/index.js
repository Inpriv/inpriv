// Inpriv Mail — mail.inpriv.xyz
// Accounts are Inpriv IDs (id.inpriv.xyz). Sign-in uses the Inpriv ID
// password; the mailbox private keys are locked with a separate mailbox
// passphrase that never leaves the browser (key format 2, see "Mailbox keys"
// below). The server stores public keys, passphrase-encrypted key rings and
// message envelopes encrypted to the recipient's public key.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";
import { canonicalRedirect } from "../../../common/canonical.js";
import { logAccess, purgeAccessLog } from "../../../common/access-log.js";
import { clientKey, originAllowed, isUnsafeMethod, pageResponse, apiHeaders, uaFamily } from "../../../common/security.js";
import { TEAM_MAILBOXES, normalizeLocal, tryClaim, claimOwner, claimMany, ensureClaims } from "../../../common/addresses.js";
import { sanitizeEmailHtml } from "../../../common/email-html.js";
import { WorkerEntrypoint } from "cloudflare:workers";

export { TEAM_MAILBOXES };

const DOMAIN = "inpriv.xyz";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const PASS_ITERS = 300_000;
const PBKDF2_CAP = 100_000;

// Mailbox keys, format 2: the browser derives a key from the mailbox
// passphrase (PBKDF2-SHA-256, at least KEY_ITERS_MIN iterations) and seals
// the key ring (every private key of the mailbox) with AES-256-GCM. Format 1
// was a single private key sealed with a key derived from the sign-in
// password, which the server also receives; it can only be upgraded.
const KEY_FORMAT = 2;
const KEY_ITERS_MIN = 600_000;
const KEY_ITERS_MAX = 10_000_000;
const MAX_KEYRING_B64 = 24_000;
const MAX_BODY_BYTES = 1_000_000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const now = () => Date.now();
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256hex(s) {
  return hexOf(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s));
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

const gone = () => bad("this endpoint was removed — reload the page", 410);

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
// Counters carry their expiry; the daily cron deletes expired rows.
async function overLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(now() / windowMs);
  try {
    const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
    return !!(row && row.c >= limit);
  } catch {
    return false; // fail open on rate limit table error
  }
}
async function bump(db, key, windowMs) {
  const bucket = Math.floor(now() / windowMs);
  try {
    await db.prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?,?,1,?) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
      .bind(key, bucket, (bucket + 1) * windowMs).run();
  } catch { /* fail open */ }
}
async function rateLimit(db, key, limit, windowMs) {
  if (await overLimit(db, key, limit, windowMs)) return false;
  await bump(db, key, windowMs);
  return true;
}

// ── Schema (additive; the same statements are in ../migrations) ────────────
let _schemaReady = false;
async function ensureSchema(env) {
  if (_schemaReady) return;
  for (const sql of [
    "ALTER TABLE users ADD COLUMN key_format INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN key_id TEXT",
    "ALTER TABLE users ADD COLUMN keys_updated_at INTEGER",
    "ALTER TABLE messages ADD COLUMN key_id TEXT",
    "ALTER TABLE rl_counters ADD COLUMN exp INTEGER",
  ]) {
    try { await env.DB.prepare(sql).run(); } catch { /* already there */ }
  }
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS key_challenges (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, answer_hash TEXT NOT NULL, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL)"
  ).run();
  await ensureDeviceKeys(env);
  _schemaReady = true;
}

// Quick Unlock device keys: one wrapped key per device (random id kept in
// the browser), up to MAX_DEVICE_KEYS per mailbox.
let _dkReady = false;
async function ensureDeviceKeys(env) {
  if (_dkReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS device_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, wrapped_dek TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id)"),
  ]);
  try { await env.DB.prepare("ALTER TABLE device_keys ADD COLUMN device_id TEXT").run(); } catch { /* already there */ }
  try { await env.DB.prepare("ALTER TABLE device_keys ADD COLUMN label TEXT").run(); } catch { /* already there */ }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_device_keys_dev ON device_keys(user_id, device_id)").run();
  _dkReady = true;
}

const MAX_DEVICE_KEYS = 10;
const validDeviceId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);

// ── Sessions ───────────────────────────────────────────────────────────────
// The session token lives in a host-only HttpOnly cookie that page scripts
// can't read (__Host- prefix: Secure, Path=/, no Domain). SameSite=Strict and
// the Origin check on every state-changing request keep other sites, and the
// other *.inpriv.xyz sites, from using it. Pages from before the cookie sent
// the token as a Bearer header; /me and /logout still accept that once, and
// /me moves it into the cookie.
const COOKIE = "__Host-inpriv_mail";
const DEV_COOKIE = "inpriv_mail"; // http://localhost only (wrangler dev)
const isDev = (url) => url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);

function sessionCookie(url, token, maxAge = SESSION_TTL_MS / 1000) {
  return isDev(url)
    ? `${DEV_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
    : `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function cookieToken(req) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)(?:__Host-inpriv_mail|inpriv_mail)=([A-Za-z0-9+/=]{20,})/);
  return m ? m[1] : null;
}

function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function authUser(req, env, allowBearer = false) {
  let token = cookieToken(req), via = "cookie";
  if (!token && allowBearer) { token = bearer(req); via = "bearer"; }
  if (!token) return null;
  const sid = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, s.id AS sid, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(sid).first();
  if (!row || row.expires_at < now()) return null;
  return { me: row, token, via, sid };
}

async function newSession(env, request, uid) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)"
  ).bind(await sha256hex(token), uid, now(), now() + SESSION_TTL_MS, uaFamily(request.headers.get("User-Agent"))).run();
  await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(now(), uid).run();
  return sessionCookie(new URL(request.url), token);
}

function publicUser(u, extra = {}) {
  return {
    id: u.id,
    username: u.username,
    email: u.address || `${u.username}@${DOMAIN}`,
    address: u.address || `${u.username}@${DOMAIN}`,
    public_key: u.public_key,
    key_id: u.key_id || null,
    key_format: u.key_format || 1,
    encrypted_private_key: u.encrypted_private_key,
    priv_iv: u.priv_iv,
    priv_salt: u.priv_salt,
    priv_iter: u.priv_iter,
    created_at: u.created_at,
    ...extra,
  };
}

// ── Mailbox keys ───────────────────────────────────────────────────────────
// A key id is the first 128 bits of SHA-256 over the public key (SPKI), in
// hex. People compare it to check they encrypt to the right key.
async function spkiKeyId(spkiB64) {
  return (await sha256hex(b64d(spkiB64))).slice(0, 32);
}

async function importPublic(spkiB64) {
  try {
    const k = await crypto.subtle.importKey("spki", b64d(spkiB64), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
    return k.algorithm.modulusLength >= 2048 ? k : null;
  } catch {
    return null;
  }
}

// The stored key id of a mailbox (filled in for mailboxes from before key ids).
async function keyIdOf(env, user) {
  if (user.key_id || !user.public_key) return user.key_id || null;
  const id = await spkiKeyId(user.public_key);
  await env.DB.prepare("UPDATE users SET key_id = ? WHERE id = ? AND key_id IS NULL").bind(id, user.id).run();
  user.key_id = id;
  return id;
}

// A passphrase-sealed key ring sent by the browser. Only the shape is
// checked: the server can't open it, by design.
function readEnvelope(body) {
  const e = body && typeof body.envelope === "object" ? body.envelope : {};
  const epk = String(e.encrypted_private_key || "");
  const iv = String(e.priv_iv || "");
  const salt = String(e.priv_salt || "");
  const iter = Number(e.priv_iter);
  if (Number(e.key_format) !== KEY_FORMAT) return { error: "unsupported key format" };
  if (!epk || epk.length > MAX_KEYRING_B64) return { error: "missing or oversized key ring" };
  try {
    if (b64d(iv).length !== 12 || b64d(salt).length < 16 || b64d(epk).length < 32) return { error: "malformed key envelope" };
  } catch {
    return { error: "malformed key envelope" };
  }
  if (!Number.isInteger(iter) || iter < KEY_ITERS_MIN || iter > KEY_ITERS_MAX) {
    return { error: `the passphrase key needs ${KEY_ITERS_MIN}–${KEY_ITERS_MAX} PBKDF2 iterations` };
  }
  return { epk, iv, salt, iter };
}

async function readNewPublicKey(body) {
  const pub = String(body.public_key || "");
  if (!pub || pub.length > 2000 || !(await importPublic(pub))) return { error: "invalid public key" };
  const id = await spkiKeyId(pub);
  if (String(body.key_id || "") !== id) return { error: "key id doesn't match the public key" };
  return { pub, id };
}

// Proof that the browser holds the mailbox's current private key: the server
// encrypts a random value to the current public key; only that private key
// can return it. Required to change the key ring (upgrade, new passphrase)
// and to add a Quick Unlock device, so a stolen session alone can't replace
// the keys or enrol a device. Single use, 5 minutes.
async function createChallenge(env, user, purpose) {
  const pub = await importPublic(user.public_key);
  if (!pub) throw new Error("mailbox has no usable public key");
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const ct = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, nonce);
  const id = hexOf(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare(
    "INSERT INTO key_challenges (id, user_id, answer_hash, purpose, expires_at) VALUES (?,?,?,?,?)"
  ).bind(id, user.id, await sha256hex(b64(nonce)), purpose, now() + 5 * 60_000).run();
  return { challenge_id: id, challenge: b64(ct) };
}

async function consumeChallenge(env, user, body, purpose) {
  const id = String(body.challenge_id || "");
  const answer = String(body.challenge_answer || "");
  if (!/^[a-f0-9]{32}$/.test(id) || !answer) return false;
  const row = await env.DB.prepare(
    "SELECT answer_hash, purpose, expires_at FROM key_challenges WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first();
  if (!row) return false;
  await env.DB.prepare("DELETE FROM key_challenges WHERE id = ?").bind(id).run();
  return row.purpose === purpose && row.expires_at >= now() && constantTimeEq(await sha256hex(answer), row.answer_hash);
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

// ── Inbound external email (Resend webhook `email.received`) ───────────────
const SVIX_TOLERANCE_S = 5 * 60;            // reject webhook timestamps outside ±5 min
const INBOUND_MAX_TEXT_CHARS = 100_000;     // stored plaintext cap (encrypted at rest)
const INBOUND_MAX_HTML_CHARS = 200_000;     // sanitized rich-part cap (encrypted at rest)

async function verifySvix(secret, svixId, svixTs, svixSigHeader, rawBody) {
  if (!secret || !svixId || !svixTs || !svixSigHeader || typeof rawBody !== "string") return false;

  const b64Secret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw", b64d(b64Secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
  } catch {
    return false;
  }
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${svixId}.${svixTs}.${rawBody}`));
  const expected = b64(mac);

  for (const part of svixSigHeader.split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) === "v1" && constantTimeEq(part.slice(comma + 1), expected)) return true;
  }
  return false;
}

// Minimal HTML → readable plain text, for mail that has no text part. Only
// the browser renders HTML, and only after its own sanitizer.
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Team mailboxes (support@, abuse@, dmca@ …) ─────────────────────────────
// Operator addresses read and answered in admin.inpriv.xyz (through the
// TeamMail entrypoint below — a Worker-to-Worker binding, not reachable from
// the internet). They're operator mail, not user mailboxes, so they're
// stored as received (not end-to-end encrypted); D1 encrypts at rest.
const TEAM_LABELS = {
  support: "Inpriv Support", abuse: "Inpriv Abuse", dmca: "Inpriv Copyright", legal: "Inpriv Legal",
  privacy: "Inpriv Privacy", security: "Inpriv Security", admin: "Inpriv", hello: "Inpriv",
};
let _teamReady = false;
async function ensureTeam(env) {
  if (_teamReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS team_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, mailbox TEXT NOT NULL, direction TEXT NOT NULL, from_addr TEXT, from_name TEXT, to_addr TEXT, subject TEXT, text TEXT, attachments TEXT, is_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, resend_id TEXT)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_team_box ON team_messages(mailbox, created_at)"),
  ]);
  _teamReady = true;
}

async function handleInbound(request, env) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: "inbound not configured: set RESEND_WEBHOOK_SECRET" }, 503);
  }

  // Verify the svix signature against the RAW body (never a re-serialized copy).
  const raw = await request.text();
  const svixId = request.headers.get("svix-id") || "";
  const svixTs = request.headers.get("svix-timestamp") || "";
  const svixSig = request.headers.get("svix-signature") || "";

  if (!(await verifySvix(secret, svixId, svixTs, svixSig, raw))) {
    return json({ error: "invalid webhook signature" }, 401);
  }
  const ts = Number(svixTs);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SVIX_TOLERANCE_S) {
    return json({ error: "webhook timestamp outside tolerance" }, 400);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (event.type !== "email.received") {
    return json({ ok: true, ignored: event.type || "unknown" });
  }

  const d = event.data || {};

  // Catch-all webhook: accept every address silently, store only for real users.
  const recipients = [
    ...(Array.isArray(d.to) ? d.to : []),
    ...(Array.isArray(d.received_for) ? d.received_for : []),
  ].map((s) => String(s).trim().toLowerCase()).filter(Boolean);

  let target = null, team = null;
  for (const r of recipients) {
    if (!r.endsWith("@" + DOMAIN)) continue;
    const local = r.slice(0, -("@" + DOMAIN).length);
    if (TEAM_MAILBOXES.includes(local)) { team = local; break; }
  }
  for (const r of team ? [] : recipients) {
    if (!r.endsWith("@" + DOMAIN)) continue;
    const row = await env.DB.prepare(
      "SELECT id, username, address, public_key, key_id FROM users WHERE address = ?"
    ).bind(r).first();
    if (row && row.public_key) { target = row; break; }
  }
  if (!target && !team) return json({ ok: true, ignored: "no such mailbox" }); // 200 → no retry, no enumeration

  // Svix delivers at least once: a retried event for a mailbox that already
  // stored it is acknowledged without storing it twice.
  if (target && env.DB) {
    await ensureSchema(env);
    const seen = await env.DB.prepare("SELECT 1 FROM rl_counters WHERE k = ?").bind(`svix:${svixId}`).first();
    if (seen) return json({ ok: true, duplicate: true });
  }

  // Webhooks carry metadata only — fetch the body via the Received emails API
  // (needs a read-capable key; metadata-only fallback if missing/unauthorized).
  const readKey = env.RESEND_READ_API_KEY || env.RESEND_API_KEY || env.RESEND_KEY || "";
  const emailId = String(d.email_id || "");
  let text = null;
  let rawHtml = null;
  let fromName = null;

  if (readKey && emailId) {
    try {
      const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      if (res.ok) {
        const email = await res.json();
        text = String(email.text || "").slice(0, INBOUND_MAX_TEXT_CHARS) || null;
        rawHtml = String(email.html || "").slice(0, INBOUND_MAX_HTML_CHARS) || null;
        if (!text && rawHtml) text = htmlToText(rawHtml).slice(0, INBOUND_MAX_TEXT_CHARS) || null;
        const hf = (email.headers && email.headers.from) || "";
        const nm = String(hf).match(/^[^<]+(?=\s*<)/);
        if (nm) fromName = nm[0].trim().replace(/^"|"$/g, "").slice(0, 200) || null;
      } else if (res.status === 401) {
        console.error("inbound: read key not read-capable (401) — storing metadata only");
      } else {
        console.error(`inbound: content fetch ${res.status}`);
      }
    } catch (err) {
      console.error("inbound: content fetch failed");
    }
  }

  // Attachment list (metadata only — names/sizes/types from the webhook).
  const atts = Array.isArray(d.attachments) ? d.attachments : [];
  let plaintext = text || "(This email had no readable text body.)";
  if (atts.length) {
    const lines = atts.map((a) => {
      const kb = Math.max(1, Math.round((a.size || 0) / 1024));
      return `• ${a.filename || "attachment"} (${a.content_type || "file"}, ~${kb} KB)`;
    });
    plaintext += `\n\n— Attachments (${atts.length}) —\n${lines.join("\n")}\n(Attachment downloads are not supported yet; only the list is stored.)`;
  }

  // Team mailbox: store as received, for the admin panel.
  if (team) {
    try {
      await ensureTeam(env);
      await env.DB.prepare(
        "INSERT INTO team_messages (mailbox, direction, from_addr, from_name, to_addr, subject, text, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
      ).bind(
        team, "in", String(d.from || "unknown@unknown").toLowerCase().slice(0, 320), fromName,
        `${team}@${DOMAIN}`, String(d.subject || "(no subject)").slice(0, 500), plaintext,
        atts.length ? JSON.stringify(atts.map((a) => ({ name: a.filename || "attachment", type: a.content_type || "", size: a.size || 0 }))) : null,
        now()
      ).run();
    } catch (err) {
      console.error("inbound: team store failed");
      return json({ error: "storage failure" }, 500);
    }
    return json({ ok: true, stored: true, team });
  }

  // Rich part: active content removed (common/email-html.js), then sealed in
  // the same envelope as the plain text. Remote images stay blocked in the
  // reader until the person loads them.
  const payload = { v: 1, text: plaintext };
  if (rawHtml) {
    try {
      const safe = await sanitizeEmailHtml(rawHtml);
      if (safe) payload.html = safe;
    } catch (err) {
      console.error("inbound: html sanitize failed — storing text only");
    }
  }

  // Encrypt to the recipient's public key — identical envelope format to
  // internal messages, so the existing browser decrypt path just works.
  let envelope;
  try {
    envelope = await serverHybridEncrypt(target.public_key, JSON.stringify(payload));
  } catch (err) {
    console.error("inbound: hybrid encrypt failed");
    return json({ error: "encryption failure" }, 500); // 500 → Resend retries
  }

  const fromAddr = String(d.from || "unknown@unknown").toLowerCase().slice(0, 320);
  const label = fromName || fromAddr.split("@")[0];

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                               encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read, key_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
      ).bind(
        target.id, "inbound", fromAddr, label,
        String(d.subject || "(no subject)").slice(0, 500),
        envelope.encrypted_aes_key, envelope.iv, envelope.ciphertext, envelope.auth_tag,
        now(), await keyIdOf(env, target)
      ),
      env.DB.prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?, 0, 1, ?) ON CONFLICT(k, bucket) DO NOTHING")
        .bind(`svix:${svixId}`, now() + 2 * 86_400_000),
    ]);
  } catch (err) {
    console.error("inbound: store failed");
    return json({ error: "storage failure" }, 500); // 500 → Resend retries
  }

  return json({ ok: true, stored: true });
}

// ── Quick Unlock policy (mirrors the Inpriv ID account setting) ──────────
// "Skip mailbox passphrase" is governed by quick_unlock in the ID's
// user_settings table. Mail reads it through the shared ID database so the
// toggle on id.inpriv.xyz takes effect here immediately. Absent row = enabled.
async function quickUnlockPolicy(env, username) {
  try {
    if (!env.ID_DB || !username) return true;
    const row = await env.ID_DB.prepare(
      `SELECT us.quick_unlock AS qu FROM users u
       LEFT JOIN user_settings us ON us.user_id = u.id
       WHERE u.username = ?`
    ).bind(String(username).toLowerCase()).first();
    if (!row) return true; // not an Inpriv ID account (local password only)
    return row.qu !== 0;
  } catch {
    return true; // DB hiccup → keep the historical default
  }
}

// ── Inpriv ID consent sync ────────────────────────────────────────────────
// The ID panel's "Connected services" card reads the consents table on the
// ID database. Every successful sign-in mirrors the consent there
// (best-effort: mailboxes without an ID match no ID user and are skipped).
async function syncIdConsent(env, username, force = false) {
  try {
    if (!env.ID_DB || !username) return;
    const iu = await env.ID_DB.prepare("SELECT id FROM users WHERE username = ?")
      .bind(String(username).toLowerCase()).first();
    if (!iu) return;
    const ts = Date.now();
    const row = await env.ID_DB.prepare(
      "SELECT last_used FROM consents WHERE user_id = ? AND service = ?"
    ).bind(iu.id, "mail").first();
    if (row && !force && row.last_used && ts - row.last_used < 3_600_000) return; // ≤1 write/h
    await env.ID_DB.prepare(
      "INSERT INTO consents (user_id, service, granted_at, last_used) VALUES (?,?,?,?) " +
      "ON CONFLICT(user_id, service) DO UPDATE SET last_used = excluded.last_used"
    ).bind(iu.id, "mail", ts, ts).run();
  } catch { /* best-effort — never block a login on this */ }
}

// ── Sign-in tickets (inpriv-id database, table id_init_tickets) ───────────
// kind "init": password (+2FA) just passed for an ID without a mailbox; it
//   lets /init-keys create the mailbox once.
// kind "sso":  Quick Sign-In proved the ID session of a 2FA account; it lets
//   /sso/verify ask for the second factor. It can never create a mailbox.
// Single use, 10 minutes, only the hash is stored.
let _iitReady = false;
async function ensureIdInitTickets(env) {
  if (_iitReady) return;
  await env.ID_DB.batch([
    env.ID_DB.prepare(
      "CREATE TABLE IF NOT EXISTS id_init_tickets (id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)"
    ),
    env.ID_DB.prepare("CREATE INDEX IF NOT EXISTS idx_iit_username ON id_init_tickets(username, created_at)"),
  ]);
  try { await env.ID_DB.prepare("ALTER TABLE id_init_tickets ADD COLUMN kind TEXT").run(); } catch { /* already there */ }
  _iitReady = true;
}

async function mintTicket(env, username, kind) {
  await ensureIdInitTickets(env);
  const tkt = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.ID_DB.prepare(
    "INSERT INTO id_init_tickets (id, username, created_at, expires_at, kind) VALUES (?,?,?,?,?)"
  ).bind(await sha256hex(tkt), username, now(), now() + 10 * 60_000, kind).run();
  return tkt;
}

async function peekTicket(env, ticket, kind) {
  if (!ticket) return null;
  await ensureIdInitTickets(env);
  const row = await env.ID_DB.prepare(
    "SELECT id, username, expires_at, used_at, kind FROM id_init_tickets WHERE id = ?"
  ).bind(await sha256hex(ticket)).first();
  if (!row || row.used_at || row.expires_at < now() || row.kind !== kind) return null;
  return row;
}

// true only for the one request that marks the ticket used
async function burnTicket(env, row) {
  const r = await env.ID_DB.prepare("UPDATE id_init_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(now(), row.id).run();
  return ((r.meta && r.meta.changes) || 0) === 1;
}

// ── TOTP verification against the Inpriv ID database (RFC 6238, SHA-1) ────
// Used only when this Worker has ID_ENC_KEY (local tests); in production
// Mail asks ID's /api/totp/verify, so the key only lives on ID.
const ID_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function idBase32Decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const i = ID_B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
async function idHotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new Uint8Array(buf));
  const b = new Uint8Array(mac);
  const off = b[19] & 0xf;
  const code = ((b[off] & 0x7f) << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
  return String(code % 1_000_000).padStart(6, "0");
}
async function idVerifyTOTP(code, secretBytes, atMs) {
  const step = Math.floor(atMs / 30_000);
  for (let w = -1; w <= 1; w++) {
    if (constantTimeEq(await idHotp(secretBytes, step + w), code)) return true;
  }
  return false;
}
async function openIdSecret(env, envelopeJson) {
  try {
    const { iv, ct } = JSON.parse(envelopeJson);
    const raw = enc.encode(env.ID_ENC_KEY);
    let keyBytes = raw;
    if (keyBytes.length !== 32 && keyBytes.length === 44) {
      try { keyBytes = b64d(env.ID_ENC_KEY); } catch { /* fallthrough */ }
    }
    if (keyBytes.length !== 32) return null;
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, key, b64d(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// Mail-only mailboxes (created on mail.inpriv.xyz before sign-up moved to
// Inpriv ID) become an Inpriv ID the next time they're used. Mail's hash is
// the same chained PBKDF2 as ID's, so it's copied as is and the password
// keeps working. Returns true when the ID was created now.
async function ensureIdAccount(env, mailUser) {
  if (!env.ID_DB || !mailUser || !mailUser.username || !mailUser.auth_hash) return false;
  try {
    const username = String(mailUser.username).toLowerCase();
    const email = `${username}@${DOMAIN}`;
    const taken = await env.ID_DB.prepare(
      "SELECT 1 FROM users WHERE username = ? OR email = ? OR recovery_email = ?"
    ).bind(username, email, email).first();
    if (taken) return false;
    await tryClaim(env.ID_DB, username, "id");
    await env.ID_DB.prepare(
      "INSERT INTO users (id, username, email, nick, pass_hash, pass_salt, pass_iters, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(), username, email, username, mailUser.auth_hash, mailUser.auth_salt,
      mailUser.priv_iter || PASS_ITERS, mailUser.created_at || now()).run();
    return true;
  } catch {
    return false; // never block mail on this; it's retried on the next use
  }
}

// Second factor for an Inpriv ID account: a 6-digit TOTP code or a single-use
// recovery code. Returns "ok", "missing" (nothing usable sent yet) or "bad".
async function checkIdSecondFactor(env, idUserId, code, recovery) {
  if (recovery) {
    const rc = await env.ID_DB.prepare(
      "SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL"
    ).bind(idUserId, await sha256hex(recovery)).first();
    if (!rc) return "bad";
    const r = await env.ID_DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now(), rc.id).run();
    return ((r.meta && r.meta.changes) || 0) === 1 ? "ok" : "bad";
  }
  if (!/^\d{6}$/.test(code)) return "missing";
  if (env.ID_ENC_KEY) {
    const trow = await env.ID_DB.prepare(
      "SELECT secret_enc FROM totp_secrets WHERE user_id = ? AND confirmed = 1"
    ).bind(idUserId).first();
    const secret = trow ? await openIdSecret(env, trow.secret_enc) : null;
    return secret && (await idVerifyTOTP(code, idBase32Decode(secret), now())) ? "ok" : "bad";
  }
  if (!env.SERVICE_KEY) return "bad";
  const u = await env.ID_DB.prepare("SELECT username FROM users WHERE id = ?").bind(idUserId).first();
  if (!u) return "bad";
  try {
    const r = await fetch(`${env.ID_ORIGIN || "https://id.inpriv.xyz"}/api/totp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Inpriv-Service": env.SERVICE_KEY },
      body: JSON.stringify({ username: u.username, code }),
    });
    const d = await r.json().catch(() => ({}));
    return r.ok && d.ok === true ? "ok" : "bad";
  } catch {
    return "bad";
  }
}

// The second factor with a per-account limit (10 wrong codes in 15 minutes,
// counted in the shared ID database so every path shares it).
async function secondFactor(env, idUser, body) {
  const code = String(body.code || "").trim();
  const recovery = String(body.recovery || "").toLowerCase().trim();
  if (!recovery && !/^\d{6}$/.test(code)) return "missing";
  if (await overLimit(env.ID_DB, `mfau:${idUser.id}`, 10, 15 * 60_000)) return "limited";
  const f = await checkIdSecondFactor(env, idUser.id, code, recovery);
  if (f !== "ok") await bump(env.ID_DB, `mfau:${idUser.id}`, 15 * 60_000);
  return f;
}

const factorError = (f, body) =>
  f === "limited" ? bad("too many wrong codes — wait 15 minutes", 429)
    : bad(body.recovery ? "invalid recovery code" : "invalid two-factor code", 401);

// Inpriv ID password check (the hash lives in the ID database).
async function idPasswordOk(idUser, password) {
  if (!idUser || !password) return false;
  return constantTimeEq(await passHash(password, idUser.pass_salt, idUser.pass_iters || PASS_ITERS), idUser.pass_hash);
}

const ID_USER_COLS = "id, username, email, nick, pass_hash, pass_salt, pass_iters, totp_enabled";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const moved = canonicalRedirect(request);
    if (moved) return moved;

    // same-origin API: no cross-origin access is granted
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    // Static frontend assets pass-through
    if (!path.startsWith("/api/")) {
      const gate = await maintenanceGate("mail");
      if (gate.locked) return maintenancePage("Inpriv Mail", gate.message);
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) return notFound(request, "Inpriv Mail");
      // registration and the One Tap widget (id.js) talk to Inpriv ID;
      // message images only load after the person asks (the reader frame has
      // its own stricter policy)
      // (local dev only: ID runs on another loopback port; a bare scheme
      // because the wrangler dev proxy rewrites host names in headers)
      const idOrigins = isDev(url) ? ["https://id.inpriv.xyz", "http:"] : ["https://id.inpriv.xyz"];
      return pageResponse(request, res, {
        "script-src": ["https://id.inpriv.xyz"],
        "connect-src": idOrigins,
        "img-src": ["https:"],
        "=frame-src": ["'self'"],
      });
    }

    const res = await api(request, env, ctx, url, path);
    return apiHeaders(res);
  },

  async scheduled(_event, env) {
    const t = now();
    await ensureSchema(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM rl_counters WHERE exp IS NULL OR exp < ?").bind(t),
      env.DB.prepare("DELETE FROM key_challenges WHERE expires_at < ?").bind(t),
    ]);
    // the inpriv-id cleanup also runs here, in case the Temp cron stops
    await purgeAccessLog(env.ID_DB, env);
    // address claims for every mailbox (once; new ones claim on creation)
    try {
      await ensureClaims(env.ID_DB);
      if (!(await env.ID_DB.prepare("SELECT 1 FROM app_meta WHERE k = 'claims_backfill_mail_v1'").first())) {
        const { results } = await env.DB.prepare("SELECT username FROM users").all();
        await claimMany(env.ID_DB, (results || []).map((r) => r.username), "id");
        await env.ID_DB.prepare("INSERT OR REPLACE INTO app_meta (k, v) VALUES ('claims_backfill_mail_v1', ?)").bind(String(t)).run();
      }
    } catch (e) {
      console.error("claims backfill (mail) failed");
    }
  },
};

async function api(request, env, ctx, url, path) {
  const gate = await maintenanceGate("mail");
  if (gate.locked && path !== "/api/v1/health" && path !== "/api/v1/inbound") {
    return maintenancePage("Inpriv Mail", gate.message);
  }

  if (path === "/api/v1/health") {
    return json({ status: "ok", service: "inpriv-mail", domain: DOMAIN, time: now() });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 0. INBOUND EMAIL (Resend webhook `email.received`, svix-signed)
  // ══════════════════════════════════════════════════════════════════════
  if (path === "/api/v1/inbound") {
    if (request.method !== "POST") return bad("method not allowed", 405);
    return handleInbound(request, env);
  }

  // Everything else is called by the Mail page itself. State-changing
  // requests from any other origin (other sites, other *.inpriv.xyz pages)
  // are refused before they touch a session.
  if (isUnsafeMethod(request) && !originAllowed(request)) {
    return bad("request refused: unknown origin", 403);
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
    return bad("request too large", 413);
  }

  try {
    await ensureSchema(env);
    const body = isUnsafeMethod(request) ? await request.json().catch(() => ({})) : {};
    const ipk = clientKey(request);

    // Endpoints of the old password-wrapped key flow and the public account
    // lookups. They answer 410 so a page loaded before this release reloads.
    if ([
      "/api/v1/register", "/api/v1/rekey", "/api/v1/password-check", "/api/v1/id-init",
      "/api/v1/available", "/api/v1/id-status", "/api/v1/users",
    ].includes(path)) return gone();

    // ══════════════════════════════════════════════════════════════════════
    // 1. SIGN-IN (Inpriv ID password, never the mailbox passphrase)
    // ══════════════════════════════════════════════════════════════════════

    // ── Sign in ───────────────────────────────────────────────────────────
    // ok           → session cookie + the mailbox's locked key ring
    // totp_required→ send again with code (or recovery)
    // needs_init   → an ID without a mailbox yet: init_ticket for /init-keys
    if (path === "/api/v1/login" && request.method === "POST") {
      if (!(await rateLimit(env.DB, `login:${ipk}`, 15, 15 * 60_000))) {
        return bad("too many attempts — please wait 15 minutes", 429);
      }
      const input = String(body.username || body.login || body.address || "").toLowerCase().trim();
      const local = normalizeLocal(input);
      const password = String(body.password || "");
      if (!local || !password) return bad("username and password required", 400);
      if (password.length > 200) return bad("invalid credentials", 401);

      const idUser = env.ID_DB ? await env.ID_DB.prepare(
        `SELECT ${ID_USER_COLS} FROM users WHERE username = ? OR email = ? OR recovery_email = ?`
      ).bind(local, `${local}@${DOMAIN}`, input).first() : null;
      const mailbox = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
        .bind(idUser ? idUser.username : local).first();
      if (!idUser && !mailbox) {
        await passHash(password, "AAAAAAAAAAAAAAAAAAAAAA=="); // same cost either way
        return bad("invalid credentials", 401);
      }

      // failed passwords per account, from any network (see ID's login)
      const acct = idUser ? `i:${idUser.id}` : `m:${mailbox.id}`;
      if (await overLimit(env.DB, `loginfail:${acct}`, 50, 3_600_000)) {
        return bad("too many failed sign-ins for this account — wait an hour", 429);
      }
      // A mailbox that belongs to an Inpriv ID signs in with the ID's current
      // password; only mailboxes that never became an ID use Mail's own hash.
      const ok = idUser
        ? await idPasswordOk(idUser, password)
        : !!mailbox.auth_hash && constantTimeEq(
          await passHash(password, mailbox.auth_salt, mailbox.priv_iter || PASS_ITERS), mailbox.auth_hash);
      if (!ok) {
        await bump(env.DB, `loginfail:${acct}`, 3_600_000);
        return bad("invalid credentials", 401);
      }

      if (idUser && idUser.totp_enabled) {
        const f = await secondFactor(env, idUser, body);
        if (f === "missing") {
          return json({ status: "totp_required", mailbox: !!mailbox, username: idUser.username, nick: idUser.nick || idUser.username });
        }
        if (f !== "ok") return factorError(f, body);
      }

      if (!mailbox || !mailbox.public_key) {
        if (!idUser) return bad("invalid credentials", 401);
        const ticket = await mintTicket(env, idUser.username, "init");
        return json({ status: "needs_init", init_ticket: ticket, username: idUser.username, nick: idUser.nick || idUser.username });
      }

      const cookie = await newSession(env, request, mailbox.id);
      const migrated = !idUser && (await ensureIdAccount(env, mailbox));
      ctx.waitUntil(syncIdConsent(env, mailbox.username, true));
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "login", mailbox.username));
      return json({ status: "ok", user: publicUser(mailbox, { inpriv_id_synced: true }), migrated }, 200, { "Set-Cookie": cookie });
    }

    // ── Quick Sign-In via Inpriv ID (SSO grant) ──────────────────────────
    // The browser (id.js) mints a one-time grant on id.inpriv.xyz; this
    // endpoint redeems it server-to-server with the shared SERVICE_KEY.
    // The mailbox stays locked: the passphrase (or this device's Quick
    // Unlock key) is still needed to open the key ring.
    if (path === "/api/v1/sso" && request.method === "POST") {
      if (!(await rateLimit(env.DB, `sso:${ipk}`, 30, 15 * 60_000))) {
        return bad("too many sign-in attempts — please wait 15 minutes", 429);
      }
      if (!env.SERVICE_KEY) return bad("SSO not configured on this service", 503);
      const grant = String(body.grant || "");
      const state = String(body.state || "");
      if (!grant) return bad("grant required", 400);

      let d = {}, r;
      try {
        r = await fetch(`${env.ID_ORIGIN || "https://id.inpriv.xyz"}/api/grant/redeem`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Inpriv-Service": env.SERVICE_KEY },
          body: JSON.stringify({ grant, service: "mail" }),
        });
        d = await r.json().catch(() => ({}));
      } catch {
        return bad("Inpriv ID unreachable", 502);
      }
      if (!r.ok || !d.ok) return bad("sign-in grant rejected", 401);
      if ((d.state || "") !== state) return bad("grant state mismatch", 401);

      // 2FA accounts: the grant alone never opens Mail
      if (d.totp_enabled) {
        const tkt = await mintTicket(env, d.user.username, "sso");
        return json({ status: "totp_required", username: d.user.username, nick: d.user.nick, sso_ticket: tkt });
      }
      const mailbox = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(d.user.username).first();
      if (!mailbox || !mailbox.public_key) {
        const ticket = await mintTicket(env, d.user.username, "init");
        return json({ status: "needs_init", init_ticket: ticket, username: d.user.username, nick: d.user.nick, quick_unlock: !!d.quick_unlock });
      }
      const cookie = await newSession(env, request, mailbox.id);
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "sso_login", mailbox.username));
      return json({ status: "ok", user: publicUser(mailbox, { inpriv_id_synced: true }), sso: true, quick_unlock: !!d.quick_unlock }, 200, { "Set-Cookie": cookie });
    }

    // ── Quick Sign-In, second factor ──────────────────────────────────────
    if (path === "/api/v1/sso/verify" && request.method === "POST") {
      if (!(await rateLimit(env.DB, `ssov:${ipk}`, 15, 15 * 60_000))) {
        return bad("too many attempts — please wait 15 minutes", 429);
      }
      const t = await peekTicket(env, String(body.sso_ticket || ""), "sso");
      if (!t) return bad("sign-in proof expired — sign in again", 401);
      const idUser = await env.ID_DB.prepare(`SELECT ${ID_USER_COLS} FROM users WHERE username = ?`).bind(t.username).first();
      if (!idUser) return bad("sign-in proof expired — sign in again", 401);
      const f = await secondFactor(env, idUser, body);
      if (f === "missing") return bad("enter the 6-digit code", 400);
      if (f !== "ok") return factorError(f, body);
      if (!(await burnTicket(env, t))) return bad("sign-in proof expired — sign in again", 401);
      const mailbox = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(idUser.username).first();
      if (!mailbox || !mailbox.public_key) {
        const ticket = await mintTicket(env, idUser.username, "init");
        return json({ status: "needs_init", init_ticket: ticket, username: idUser.username, nick: idUser.nick || idUser.username });
      }
      const cookie = await newSession(env, request, mailbox.id);
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "login_2fa", mailbox.username));
      return json({ status: "ok", user: publicUser(mailbox, { inpriv_id_synced: true }) }, 200, { "Set-Cookie": cookie });
    }

    // ── Create the mailbox (first use of an Inpriv ID) ────────────────────
    // The browser generated the key pair and sealed the key ring with the
    // new mailbox passphrase. Needs the init ticket from a sign-in that just
    // passed the password and, when on, 2FA. No password is sent here.
    if (path === "/api/v1/init-keys" && request.method === "POST") {
      if (!(await rateLimit(env.DB, `init:${ipk}`, 10, 3_600_000))) {
        return bad("too many attempts — please wait an hour", 429);
      }
      const k = await readNewPublicKey(body);
      if (k.error) return bad(k.error, 400);
      const e = readEnvelope(body);
      if (e.error) return bad(e.error, 400);
      const t = await peekTicket(env, String(body.init_ticket || ""), "init");
      if (!t) return bad("sign-in expired — sign in again", 401);
      const idUser = await env.ID_DB.prepare("SELECT id, username FROM users WHERE username = ?").bind(t.username).first();
      if (!idUser) return bad("Inpriv ID account not found", 404);

      // the address must belong to this ID, not to a Temp inbox or a team mailbox
      await tryClaim(env.ID_DB, idUser.username, "id");
      if ((await claimOwner(env.ID_DB, idUser.username)) !== "id") {
        return bad("this address is held by another Inpriv service", 409);
      }
      // Never replace the keys of a live mailbox: its private keys are the
      // only way to read the mail sent to it.
      const existing = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(idUser.username).first();
      if (existing && existing.public_key) return bad("this mailbox is already set up — sign in instead", 409);
      if (!(await burnTicket(env, t))) return bad("sign-in expired — sign in again", 401);

      const address = `${idUser.username}@${DOMAIN}`;
      let uid;
      if (existing) {
        await env.DB.prepare(
          `UPDATE users SET public_key = ?, key_id = ?, key_format = ?, encrypted_private_key = ?, priv_iv = ?,
                            priv_salt = ?, priv_iter = ?, keys_updated_at = ? WHERE id = ? AND (public_key IS NULL OR public_key = '')`
        ).bind(k.pub, k.id, KEY_FORMAT, e.epk, e.iv, e.salt, e.iter, now(), existing.id).run();
        uid = existing.id;
      } else {
        const res = await env.DB.prepare(
          `INSERT INTO users (username, address, auth_hash, auth_salt, public_key, key_id, key_format,
                              encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at, keys_updated_at)
           VALUES (?,?,'','',?,?,?,?,?,?,?,?,?)`
        ).bind(idUser.username, address, k.pub, k.id, KEY_FORMAT, e.epk, e.iv, e.salt, e.iter, now(), now()).run();
        uid = res.meta?.last_row_id;
      }
      const cookie = await newSession(env, request, uid);
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
      ctx.waitUntil(syncIdConsent(env, idUser.username, true));
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "mailbox_created", idUser.username));
      return json({ status: "ok", user: publicUser(user, { inpriv_id_synced: true }) }, 200, { "Set-Cookie": cookie });
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. AUTHENTICATED MAILBOX OPERATIONS
    // ══════════════════════════════════════════════════════════════════════
    const auth = await authUser(request, env, path === "/api/v1/me" || path === "/api/v1/logout");
    if (!auth) return bad("unauthorized — session invalid or expired", 401);
    const me = auth.me;
    let m;

    // ── Profile and the locked key ring ───────────────────────────────────
    if (path === "/api/v1/me" && request.method === "GET") {
      const migrated = await ensureIdAccount(env, me);
      const qu = await quickUnlockPolicy(env, me.username);
      const dc = await env.DB.prepare("SELECT COUNT(*) AS n FROM device_keys WHERE user_id = ?").bind(me.id).first();
      await keyIdOf(env, me);
      ctx.waitUntil(syncIdConsent(env, me.username, false));
      // a page from before the cookie sent its token as Bearer: move it into
      // the cookie so the page can forget it
      const extra = auth.via === "bearer" ? { "Set-Cookie": sessionCookie(url, auth.token) } : {};
      return json(publicUser(me, { quick_unlock: qu, quick_unlock_devices: dc ? dc.n : 0, migrated }), 200, extra);
    }

    // ── Sign out (this session) ───────────────────────────────────────────
    if (path === "/api/v1/logout" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(auth.sid).run();
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(url, "x", 0) });
    }

    // ── Sign out every other session ──────────────────────────────────────
    if (path === "/api/v1/sessions/revoke-others" && request.method === "POST") {
      const r = await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.id, auth.sid).run();
      return json({ ok: true, removed: (r.meta && r.meta.changes) || 0 });
    }

    // ── Proof-of-possession challenge (see createChallenge) ───────────────
    if (path === "/api/v1/keys/challenge" && request.method === "POST") {
      const purpose = String(body.purpose || "");
      if (!["migrate", "rewrap", "device"].includes(purpose)) return bad("unknown purpose", 400);
      if (!(await rateLimit(env.DB, `chal:${me.id}`, 60, 3_600_000))) return bad("too many requests", 429);
      return json(await createChallenge(env, me, purpose));
    }

    // ── Upgrade a format-1 mailbox to a mailbox passphrase ────────────────
    // The browser opened the old key with the sign-in password, generated a
    // new key pair for future mail, and sealed both keys (the old one stays
    // for earlier mail) under the new passphrase. Compare-and-swap on the
    // old public key: only one device's upgrade can win; the others get 409
    // and unlock the new key ring instead. Device keys made for the old key
    // are removed. There is no way back to format 1.
    if (path === "/api/v1/keys/migrate" && request.method === "POST") {
      if ((me.key_format || 1) !== 1) return bad("this mailbox already uses a passphrase", 409);
      const k = await readNewPublicKey(body);
      if (k.error) return bad(k.error, 400);
      const e = readEnvelope(body);
      if (e.error) return bad(e.error, 400);
      if (!(await consumeChallenge(env, me, body, "migrate"))) return bad("key proof failed — unlock again", 403);
      const oldId = await keyIdOf(env, me);
      if (k.id === oldId) return bad("the upgrade needs a new key pair", 400);
      const r = await env.DB.prepare(
        `UPDATE users SET public_key = ?, key_id = ?, key_format = ?, encrypted_private_key = ?, priv_iv = ?,
                          priv_salt = ?, priv_iter = ?, keys_updated_at = ?
         WHERE id = ? AND key_format = 1 AND public_key = ?`
      ).bind(k.pub, k.id, KEY_FORMAT, e.epk, e.iv, e.salt, e.iter, now(), me.id, me.public_key).run();
      if (((r.meta && r.meta.changes) || 0) !== 1) return bad("the mailbox changed meanwhile — reload", 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE messages SET key_id = ? WHERE owner_id = ? AND key_id IS NULL").bind(oldId, me.id),
        env.DB.prepare("DELETE FROM device_keys WHERE user_id = ?").bind(me.id),
      ]);
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "mailbox_key_upgraded", me.username));
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
      return json({ ok: true, user: publicUser(user, { inpriv_id_synced: true }) });
    }

    // ── New mailbox passphrase (same keys, new seal) ──────────────────────
    // Compare-and-swap on the previous salt. Every Quick Unlock device key
    // and every other session ends: they hold the previous passphrase key.
    if (path === "/api/v1/keys/rewrap" && request.method === "POST") {
      if ((me.key_format || 1) !== KEY_FORMAT) return bad("upgrade the mailbox first", 409);
      const e = readEnvelope(body);
      if (e.error) return bad(e.error, 400);
      if (!(await consumeChallenge(env, me, body, "rewrap"))) return bad("key proof failed — unlock again", 403);
      const r = await env.DB.prepare(
        `UPDATE users SET encrypted_private_key = ?, priv_iv = ?, priv_salt = ?, priv_iter = ?, keys_updated_at = ?
         WHERE id = ? AND key_format = ? AND priv_salt = ?`
      ).bind(e.epk, e.iv, e.salt, e.iter, now(), me.id, KEY_FORMAT, String(body.previous_salt || "")).run();
      if (((r.meta && r.meta.changes) || 0) !== 1) return bad("the mailbox changed meanwhile — reload", 409);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM device_keys WHERE user_id = ?").bind(me.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.id, auth.sid),
      ]);
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "mailbox_passphrase_changed", me.username));
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
      return json({ ok: true, user: publicUser(user, { inpriv_id_synced: true }) });
    }

    // ── Forgotten passphrase: start over with a new key ───────────────────
    // Nobody can recover the passphrase, so the earlier key ring is replaced
    // by a new one with one new key. Mail encrypted to the earlier keys stays
    // stored but can't be opened again. Because this hands future mail to a
    // new key, it needs the Inpriv ID password and, when on, 2FA in this
    // request: a session alone isn't enough.
    if (path === "/api/v1/keys/reset" && request.method === "POST") {
      if (!(await rateLimit(env.DB, `reset:${me.id}`, 5, 3_600_000))) return bad("too many attempts — wait an hour", 429);
      const idUser = env.ID_DB ? await env.ID_DB.prepare(`SELECT ${ID_USER_COLS} FROM users WHERE username = ?`).bind(me.username).first() : null;
      if (!idUser || !(await idPasswordOk(idUser, String(body.password || "")))) return bad("wrong Inpriv ID password", 401);
      if (idUser.totp_enabled) {
        const f = await secondFactor(env, idUser, body);
        if (f === "missing") return json({ status: "totp_required" }, 200);
        if (f !== "ok") return factorError(f, body);
      }
      const k = await readNewPublicKey(body);
      if (k.error) return bad(k.error, 400);
      const e = readEnvelope(body);
      if (e.error) return bad(e.error, 400);
      const oldId = await keyIdOf(env, me);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET public_key = ?, key_id = ?, key_format = ?, encrypted_private_key = ?, priv_iv = ?,
                            priv_salt = ?, priv_iter = ?, keys_updated_at = ? WHERE id = ?`
        ).bind(k.pub, k.id, KEY_FORMAT, e.epk, e.iv, e.salt, e.iter, now(), me.id),
        env.DB.prepare("UPDATE messages SET key_id = ? WHERE owner_id = ? AND key_id IS NULL").bind(oldId, me.id),
        env.DB.prepare("DELETE FROM device_keys WHERE user_id = ?").bind(me.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(me.id, auth.sid),
      ]);
      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "mailbox_key_reset", me.username));
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
      return json({ status: "ok", user: publicUser(user, { inpriv_id_synced: true }) });
    }

    // ── Quick Unlock device keys ("Skip mailbox passphrase") ──────────────
    // The browser keeps a random device key in its storage; here we keep
    // only the passphrase key wrapped under that device key. A device that
    // is enrolled opens the mailbox without the passphrase; anyone with that
    // browser profile (or script running on mail.inpriv.xyz) can too.
    if (path === "/api/v1/device-key/get" && request.method === "GET") {
      if (!(await quickUnlockPolicy(env, me.username))) return bad("quick unlock disabled on this account", 403);
      const device = url.searchParams.get("device") || "";
      let row = validDeviceId(device) && await env.DB.prepare(
        "SELECT id, wrapped_dek FROM device_keys WHERE user_id = ? AND device_id = ?"
      ).bind(me.id, device).first();
      // one key stored before keys were kept per device (format-1 mailboxes)
      if (!row && (me.key_format || 1) === 1) {
        row = await env.DB.prepare(
          "SELECT id, wrapped_dek FROM device_keys WHERE user_id = ? AND device_id IS NULL ORDER BY created_at DESC LIMIT 1"
        ).bind(me.id).first();
      }
      if (row) ctx.waitUntil(env.DB.prepare("UPDATE device_keys SET last_used = ? WHERE id = ?").bind(now(), row.id).run());
      return json({ wrapped_dek: row ? row.wrapped_dek : null });
    }
    if (path === "/api/v1/device-key/set" && request.method === "POST") {
      if (!(await quickUnlockPolicy(env, me.username))) return bad("quick unlock disabled on this account", 403);
      const wrapped = typeof body.wrapped_dek === "string" ? body.wrapped_dek : "";
      if (!wrapped) return bad("wrapped_dek required", 400);
      if (wrapped.length > 8000) return bad("wrapped key too large", 413);
      if (!validDeviceId(body.device_id)) return bad("device_id required", 400);
      if ((me.key_format || 1) !== KEY_FORMAT) return bad("upgrade the mailbox first", 409);
      if (!(await consumeChallenge(env, me, body, "device"))) return bad("key proof failed — unlock again", 403);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM device_keys WHERE user_id = ? AND device_id = ?").bind(me.id, body.device_id),
        env.DB.prepare("INSERT INTO device_keys (user_id, device_id, wrapped_dek, created_at, last_used, label) VALUES (?,?,?,?,?,?)")
          .bind(me.id, body.device_id, wrapped, now(), now(), uaFamily(request.headers.get("User-Agent"))),
        env.DB.prepare(
          "DELETE FROM device_keys WHERE user_id = ? AND id NOT IN (SELECT id FROM device_keys WHERE user_id = ? ORDER BY COALESCE(last_used, created_at) DESC LIMIT ?)"
        ).bind(me.id, me.id, MAX_DEVICE_KEYS),
      ]);
      return json({ ok: true });
    }
    if (path === "/api/v1/device-key/list" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT device_id, label, created_at, last_used FROM device_keys WHERE user_id = ? ORDER BY COALESCE(last_used, created_at) DESC"
      ).bind(me.id).all();
      return json({ devices: results || [] });
    }
    if (path === "/api/v1/device-key/clear" && request.method === "POST") {
      // with a device_id: forget just that device; without: every device
      if (validDeviceId(body.device_id)) {
        await env.DB.prepare("DELETE FROM device_keys WHERE user_id = ? AND device_id = ?").bind(me.id, body.device_id).run();
      } else {
        await env.DB.prepare("DELETE FROM device_keys WHERE user_id = ?").bind(me.id).run();
      }
      return json({ ok: true });
    }

    // ── Quick Unlock account toggle (same setting as id.inpriv.xyz) ───────
    // Turning it off removes every device key here and the ID-side blob.
    if (path === "/api/v1/quick-unlock" && request.method === "POST") {
      if (typeof body.enabled !== "boolean") return bad("enabled (boolean) required", 400);
      if (!env.ID_DB) return bad("inpriv id unavailable", 503);
      const iu = await env.ID_DB.prepare("SELECT id FROM users WHERE username = ?").bind(me.username).first();
      if (!iu) return bad("no inpriv id account linked to this mailbox", 409);
      await env.ID_DB.prepare(
        "INSERT INTO user_settings (user_id, quick_unlock, updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(user_id) DO UPDATE SET quick_unlock = excluded.quick_unlock, updated_at = excluded.updated_at"
      ).bind(iu.id, body.enabled ? 1 : 0, now()).run();
      if (!body.enabled) {
        await env.DB.prepare("DELETE FROM device_keys WHERE user_id = ?").bind(me.id).run();
        await env.ID_DB.prepare("DELETE FROM quick_unlock WHERE user_id = ?").bind(iu.id).run();
      }
      return json({ ok: true, quick_unlock: body.enabled });
    }

    // ── A recipient's public key (signed-in only) ─────────────────────────
    // Needed to encrypt to another Inpriv user. The page shows the key id
    // and warns when a known recipient's key changes; the server can't be
    // ruled out as the source of a swapped key otherwise.
    if ((m = path.match(/^\/api\/v1\/users\/([a-z0-9._-]+)\/pubkey$/)) && request.method === "GET") {
      if (!(await rateLimit(env.DB, `pk:${me.id}`, 300, 3_600_000))) return bad("too many lookups — wait a bit", 429);
      const target = await env.DB.prepare(
        "SELECT id, public_key, key_id, address FROM users WHERE username = ?"
      ).bind(m[1].toLowerCase()).first();
      if (target && target.public_key) {
        return json({ public_key: target.public_key, key_id: await keyIdOf(env, target), address: target.address, has_keys: true });
      }
      return bad("recipient not found or has no mailbox yet", 404);
    }

    // ── List Messages ─────────────────────────────────────────────────────
    if (path === "/api/v1/messages" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, direction, peer_address, peer_label, subject, is_read, created_at
         FROM messages WHERE owner_id = ?
         ORDER BY created_at DESC LIMIT 200`
      ).bind(me.id).all();
      return json({ items: rows.results || [] });
    }

    // ── Get Single Message Envelope (Marks Read) ──────────────────────────
    if ((m = path.match(/^\/api\/v1\/messages\/(\d+)$/)) && request.method === "GET") {
      const msg = await env.DB.prepare(
        `SELECT id, direction, peer_address, peer_label, subject, encrypted_aes_key,
                iv, ciphertext, auth_tag, is_read, created_at, key_id
         FROM messages WHERE id = ? AND owner_id = ?`
      ).bind(Number(m[1]), me.id).first();

      if (!msg) return bad("message not found", 404);

      if (!msg.is_read && msg.direction === "inbound") {
        await env.DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ? AND owner_id = ?").bind(msg.id, me.id).run();
        msg.is_read = 1;
      }
      return json(msg);
    }

    // ── Send Message (Inpriv E2EE or external relay) ──────────────────────
    if (path === "/api/v1/messages/send" && request.method === "POST") {
      let rawTo = String(body.to_username || body.to || "").toLowerCase().trim();
      const subject = String(body.subject || "").slice(0, 200);
      const isExternal = body.mode === "external" || (rawTo.includes("@") && !rawTo.endsWith("@" + DOMAIN));

      if (!(await rateLimit(env.DB, `send:${me.id}`, 40, 3_600_000))) {
        return bad("rate limit exceeded (40 messages/hour)", 429);
      }
      if ((me.key_format || 1) !== KEY_FORMAT) return bad("set your mailbox passphrase first", 409);
      const myKeyId = await keyIdOf(env, me);
      if (String(body.sender_key_id || "") !== myKeyId) return bad("your mailbox key changed — reload", 409);

      const t = now();

      if (isExternal) {
        const toEmail = rawTo;
        if (!/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(toEmail) || toEmail.length > 254) {
          return bad("invalid recipient email address", 400);
        }

        const resendKey = env.RESEND_API_KEY || env.RESEND_KEY;
        if (!resendKey) {
          return bad("external email relay is not configured on this server", 503);
        }

        const textBody = String(body.text || body.body || "").slice(0, 50_000);
        if (!textBody) {
          return bad("message body cannot be empty", 400);
        }

        // the sender's copy for the Sent box, encrypted in the browser
        const se = body.sender_envelope || {};
        const sndEak = String(se.encrypted_aes_key || "");
        const iv = String(se.iv || "");
        const ct = String(se.ciphertext || "");
        const tag = String(se.auth_tag || "");

        if (!sndEak || !iv || !ct || !tag) {
          return bad("missing sender encrypted envelope for Sent box", 400);
        }
        if (ct.length > 300_000) return bad("message body exceeds maximum size (200 KB)", 400);

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
          return bad("could not reach the mail relay — try again", 502);
        }

        if (resendRes.status >= 400) {
          return bad("mail relay error: " + String(resendRes.body?.message || "failed to send").slice(0, 200), 502);
        }

        const peerLabel = toEmail.split("@")[0];
        const r1 = await env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read, key_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`
        ).bind(me.id, "outbound", toEmail, peerLabel, subject, sndEak, iv, ct, tag, t, myKeyId).run();

        ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "send_external", me.username));
        return json({ ok: true, id: r1.meta?.last_row_id, external: true });
      }

      // Internal Inpriv E2EE message
      let toUser = rawTo;
      if (toUser.endsWith("@" + DOMAIN)) toUser = toUser.slice(0, -("@" + DOMAIN).length).trim();

      const target = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(toUser).first();
      if (!target || !target.public_key) {
        return bad("recipient not found or has no mailbox yet", 404);
      }
      // encrypted to the recipient's current key only: after a recipient
      // upgrades or resets, nothing new goes to the key they left behind
      if (String(body.recipient_key_id || "") !== (await keyIdOf(env, target))) {
        return bad("the recipient's mailbox key changed — check it and send again", 409);
      }

      const re = body.recipient_envelope || {};
      const se = body.sender_envelope || {};
      const recEak = String(re.encrypted_aes_key || "");
      const sndEak = String(se.encrypted_aes_key || "");
      const iv = String(re.iv || "");
      const ct = String(re.ciphertext || "");
      const tag = String(re.auth_tag || "");

      if (!recEak || !sndEak || !iv || !ct || !tag) return bad("missing encrypted message envelope", 400);
      if (ct.length > 300_000) return bad("message body exceeds maximum size (200 KB)", 400);

      const r = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read, key_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`
        ).bind(me.id, "outbound", target.address, target.username, subject, sndEak, iv, ct, tag, t, myKeyId),
        env.DB.prepare(
          `INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject,
                                 encrypted_aes_key, iv, ciphertext, auth_tag, created_at, is_read, key_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
        ).bind(target.id, "inbound", me.address, me.username, subject, recEak, iv, ct, tag, t, target.key_id),
      ]);

      ctx.waitUntil(logAccess(env.ID_DB, request, "mail", "send", me.username));
      return json({ ok: true, id: r[0].meta?.last_row_id, external: false });
    }

    // ── Delete Message ────────────────────────────────────────────────────
    if (path === "/api/v1/messages/delete" && request.method === "POST") {
      const r = await env.DB.prepare("DELETE FROM messages WHERE id = ? AND owner_id = ?")
        .bind(Number(body.id), me.id).run();
      if (!((r.meta && r.meta.changes) || 0)) return bad("message not found", 404);
      return json({ ok: true });
    }

    return bad("endpoint not found", 404);
  } catch (e) {
    // details go to the Worker log, never to the caller
    console.error("mail api error", path, e && e.message);
    return json({ error: "internal server error" }, 500);
  }
}

// ── TeamMail: the team mailboxes, for admin.inpriv.xyz ───────────────────────
// Only reachable through admin's service binding (entrypoint "TeamMail");
// admin checks its own session before calling any of this.
export class TeamMail extends WorkerEntrypoint {
  async summary() {
    await ensureTeam(this.env);
    const r = await this.env.DB.prepare(
      "SELECT mailbox, COUNT(*) AS total, SUM(CASE WHEN direction = 'in' AND is_read = 0 THEN 1 ELSE 0 END) AS unread FROM team_messages GROUP BY mailbox"
    ).all();
    const by = new Map((r.results || []).map((x) => [x.mailbox, x]));
    return TEAM_MAILBOXES.map((m) => ({
      mailbox: m, address: `${m}@${DOMAIN}`, label: TEAM_LABELS[m],
      total: (by.get(m) || {}).total || 0, unread: (by.get(m) || {}).unread || 0,
    }));
  }

  async list(mailbox, limit = 100) {
    if (!TEAM_MAILBOXES.includes(mailbox)) throw new Error("unknown mailbox");
    await ensureTeam(this.env);
    const r = await this.env.DB.prepare(
      "SELECT id, direction, from_addr, from_name, to_addr, subject, substr(text, 1, 160) AS snippet, is_read, created_at FROM team_messages WHERE mailbox = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(mailbox, Math.min(500, Math.max(1, limit | 0))).all();
    return r.results || [];
  }

  async get(id) {
    await ensureTeam(this.env);
    const m = await this.env.DB.prepare("SELECT * FROM team_messages WHERE id = ?").bind(id | 0).first();
    if (m && !m.is_read) await this.env.DB.prepare("UPDATE team_messages SET is_read = 1 WHERE id = ?").bind(m.id).run();
    return m || null;
  }

  async setRead(id, read) {
    await ensureTeam(this.env);
    await this.env.DB.prepare("UPDATE team_messages SET is_read = ? WHERE id = ?").bind(read ? 1 : 0, id | 0).run();
    return true;
  }

  async remove(id) {
    await ensureTeam(this.env);
    await this.env.DB.prepare("DELETE FROM team_messages WHERE id = ?").bind(id | 0).run();
    return true;
  }

  async send({ mailbox, to, subject, text }) {
    if (!TEAM_MAILBOXES.includes(mailbox)) throw new Error("unknown mailbox");
    to = String(to || "").trim().toLowerCase();
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/.test(to)) throw new Error("invalid recipient address");
    subject = String(subject || "").slice(0, 300) || "(no subject)";
    text = String(text || "").slice(0, 50_000);
    if (!text.trim()) throw new Error("the message is empty");
    const key = this.env.RESEND_API_KEY || this.env.RESEND_KEY;
    if (!key) throw new Error("sending isn't configured (RESEND_API_KEY)");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${TEAM_LABELS[mailbox]} <${mailbox}@${DOMAIN}>`, to, subject, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("mail relay error: " + (body.message || res.status));
    await ensureTeam(this.env);
    const r = await this.env.DB.prepare(
      "INSERT INTO team_messages (mailbox, direction, from_addr, from_name, to_addr, subject, text, is_read, created_at, resend_id) VALUES (?,?,?,?,?,?,?,1,?,?)"
    ).bind(mailbox, "out", `${mailbox}@${DOMAIN}`, TEAM_LABELS[mailbox], to, subject, text, now(), body.id || null).run();
    return { ok: true, id: r.meta && r.meta.last_row_id };
  }
}
