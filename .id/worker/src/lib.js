import { b64, b64d, now, uuid, sha256hex, passHash, constantTimeEq, base32Decode, base32Encode, verifyTOTP, PASS_ITERS } from "../../../common/crypto.js";
export { b64, b64d, now, uuid, sha256hex, passHash, constantTimeEq, base32Decode, base32Encode, verifyTOTP, PASS_ITERS };
// Inpriv ID — shared helpers: crypto, encoding, CORS, rate limit, e-mail.
import { uaFamily } from "../../../common/security.js";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const COOKIE_NAME = "inpriv_id";

export const ORIGINS = new Set([
  "https://inpriv.xyz",
  "https://www.inpriv.xyz",
  "https://mail.inpriv.xyz",
  "https://temp.inpriv.xyz",
  "https://id.inpriv.xyz",
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

import { json } from "../../../common/http.js";
export { json };

export const bad = (msg, status = 400) => json({ error: msg }, status);

// Exact origins only (no wildcard subdomains). Local development can add
// its own through the DEV_ORIGINS variable in .dev.vars, never in production.
export function allowedOrigins(env) {
  const extra = String((env && env.DEV_ORIGINS) || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.length ? new Set([...ORIGINS, ...extra]) : ORIGINS;
}

export function corsFor(req, env) {
  const o = req.headers.get("Origin") || "";
  if (allowedOrigins(env).has(o)) {
    return {
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

// ── AES-256-GCM (TOTP secrets + vault) ──────────────────────────────────────
let _aesKeyCache = null;
async function aesKey(env) {
  if (_aesKeyCache) return _aesKeyCache;
  let raw = enc.encode(env.ID_ENC_KEY);
  if (raw.length !== 32 && raw.length === 44) {
    // base64-encoded 32-byte key — decode it
    try { raw = b64d(env.ID_ENC_KEY); } catch { /* fallthrough */ }
  }
  if (raw.length !== 32) throw new Error("ID_ENC_KEY must be 32 bytes (raw or base64)");
  _aesKeyCache = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return _aesKeyCache;
}

export async function sealString(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plaintext));
  return JSON.stringify({ iv: b64(iv), ct: b64(ct) });
}

export async function openString(env, envelopeJson) {
  try {
    const { iv, ct } = JSON.parse(envelopeJson);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, await aesKey(env), b64d(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export { rateLimit, overLimit, bump } from "../../../common/rate-limit.js";
import { rateLimit } from "../../../common/rate-limit.js";

// ── request context ─────────────────────────────────────────────────────────
export const parseUA = uaFamily;

export function ipPrefix(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return parts.slice(0, 2).join(".");
  return ip.slice(0, 12) || "unknown";
}

// ── e-mail via Resend ───────────────────────────────────────────────────────
export async function sendMail(env, to, subject, text, html) {
  // local development only (set in .dev.vars, never in production): log
  // instead of sending, so the flows can be tested without a mail key
  if (env.DEV_MAIL_LOG === "1") { console.log(`[dev mail] to=${to} subject=${subject}`); return { ok: true }; }
  if (!env.RESEND_API_KEY) return { ok: false, reason: "no key" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Inpriv <noreply@inpriv.xyz>", to: [to], subject, text, html }),
    });
    if (!r.ok) return { ok: false, reason: (await r.text().catch(() => "?")).slice(0, 200) };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 200) };
  }
}

// ── Inpriv emails ───────────────────────────────────────────────────────────
// Same look as the sites: ink background, one warm accent, system fonts.
// Dark by default; mail apps that follow a light system theme get the light
// palette from the media query (apps that ignore it, like Gmail, stay dark).
// No images or remote resources, so opening the mail loads nothing.
const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// title: plain text. body: trusted HTML built by the caller (escape any user
// value with emailEsc). preheader: the preview line shown in inbox lists.
export const emailEsc = esc;
export const emailShell = (title, body, preheader = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light">` +
  `<title>${esc(title)}</title><style>` +
  `:root{color-scheme:dark light;supported-color-schemes:dark light}` +
  `a{color:inherit}` +
  `@media (prefers-color-scheme: light){` +
  `.ip-bg{background:#ebe9e4!important}.ip-card{background:#ffffff!important;border-color:#dcd9d2!important}` +
  `.ip-t1{color:#141412!important}.ip-t2{color:#55534d!important}.ip-t3{color:#8a877f!important}` +
  `.ip-code{background:#f2f0eb!important;color:#141412!important;border-color:#dcd9d2!important}` +
  `.ip-up{border-bottom-color:#141412!important}.ip-dn{border-top-color:#141412!important}}` +
  `</style></head>` +
  `<body class="ip-bg" style="margin:0;padding:0;background:#0c0c0b">` +
  (preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>` : "") +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="ip-bg" style="background:#0c0c0b">` +
  `<tr><td align="center" style="padding:40px 16px">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px">` +
  // wordmark: the Inpriv mark (two stacked triangles, same proportions as the
  // site's SVG logo) + name. Drawn with CSS borders because mail apps drop SVG
  // and text glyphs like ▲▼ come out as a small sort arrow.
  `<tr><td style="padding:0 6px 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
  `<td style="padding-right:9px;vertical-align:middle">` +
  `<div class="ip-up" style="width:0;height:0;font-size:0;line-height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:9px solid #f2f1ed"></div>` +
  `<div style="height:1px;font-size:0;line-height:0"></div>` +
  `<div class="ip-dn" style="width:0;height:0;font-size:0;line-height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:9px solid #f2f1ed"></div></td>` +
  `<td class="ip-t1" style="vertical-align:middle;color:#f2f1ed;font:700 19px/1 ${EMAIL_FONT};letter-spacing:-0.3px">Inpriv</td>` +
  `</tr></table></td></tr>` +
  `<tr><td class="ip-card" style="background:#171716;border:1px solid #2a2a27;border-radius:24px;padding:30px 28px">` +
  `<h1 class="ip-t1" style="margin:0 0 10px;color:#f2f1ed;font:700 22px/1.25 ${EMAIL_FONT};letter-spacing:-0.4px">${esc(title)}</h1>` +
  `<div class="ip-t2" style="color:#a8a69f;font:400 15px/1.6 ${EMAIL_FONT}">${body}</div>` +
  `</td></tr>` +
  `<tr><td class="ip-t3" style="padding:18px 6px 0;color:#6f6d67;font:400 12px/1.6 ${EMAIL_FONT}">` +
  `Didn't ask for this? You can ignore this email. Nothing changes until the code is entered.<br>` +
  `<span style="color:#ff6a2b">&#9679;</span>&nbsp;Inpriv &middot; <a href="https://inpriv.xyz" style="color:inherit">inpriv.xyz</a> &middot; ` +
  `<a href="https://inpriv.xyz/privacy" style="color:inherit">Privacy</a></td></tr>` +
  `</table></td></tr></table></body></html>`;

// An address in the text. Mail apps (Gmail) turn bare addresses into blue
// links; making it our own link in the text colour keeps it on-brand.
export const emailAddr = (addr) =>
  `<a class="ip-t1" href="mailto:${esc(addr)}" style="color:#f2f1ed;text-decoration:none;font-weight:700">${esc(addr)}</a>`;

export const codeBlock = (code) =>
  `<div class="ip-code" style="margin:22px 0;padding:18px 12px;border-radius:16px;background:#0c0c0b;border:1px solid #2a2a27;` +
  `color:#f2f1ed;text-align:center;font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:10px">${esc(code)}</div>`;

// Host-only (no Domain), HttpOnly, Secure. SameSite=Strict: the other Inpriv
// sites are the same site, so their One Tap requests still carry it, while
// pages on other domains can't make the browser send it. Partitioned stays so
// the cookie replaces the one set before (same partition, same name).
export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; Secure; HttpOnly; SameSite=Strict; Partitioned`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Partitioned`;
}

// Random-IV AES-GCM protects low-entropy codes even if the database leaks.
// Legacy hashes remain readable so existing recovery codes keep working.
export async function protectCode(env, code) {
  return "sealed:" + await sealString(env, await sha256hex(code));
}
export async function codeMatches(env, code, stored) {
  const modern = stored.startsWith("sealed:");
  const hash = modern ? await openString(env, stored.slice(7)) : stored.startsWith("legacy-sealed:") ? await openString(env, stored.slice(14)) : stored;
  const input = !modern && code.includes("\0") ? code.split("\0").pop() : code;
  return constantTimeEq(await sha256hex(input), hash);
}

// Prepare a single conditional write; only its winner may use this factor.
// A caller creating a session batches this write with the guarded INSERT.
export async function factorStatement(env, uid, body, setup = false) {
  const recovery = String(body.recovery || "").toLowerCase().trim();
  if (recovery && !setup) {
    const rows = await env.DB.prepare("SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(uid).all();
    for (const row of rows.results) {
      if (await codeMatches(env, recovery, row.code_hash)) {
        return env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now(), row.id);
      }
    }
    return null;
  }
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  const row = await env.DB.prepare("SELECT secret_enc, confirmed FROM totp_secrets WHERE user_id = ?").bind(uid).first();
  const secret = row && (setup || row.confirmed) ? await openString(env, row.secret_enc) : null;
  const step = secret ? await verifyTOTP(code, base32Decode(secret), now()) : false;
  if (step === false) return null;
  return env.DB.prepare("UPDATE totp_secrets SET last_step = ? WHERE user_id = ? AND (last_step IS NULL OR last_step < ?)").bind(step, uid, step);
}
export async function consumeFactor(env, uid, body, setup = false) {
  const stmt = await factorStatement(env, uid, body, setup);
  return !!stmt && (await stmt.run()).meta.changes === 1;
}
