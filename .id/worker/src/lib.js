// Inpriv ID — shared helpers: crypto, encoding, CORS, rate limit, e-mail.
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const COOKIE_NAME = "inpriv_id";
export const PASS_ITERS = 300_000; // 3 × 100k chained rounds (CF cap: 100k/call)

export const ORIGINS = new Set([
  "https://inpriv.xyz",
  "https://www.inpriv.xyz",
  "https://mail.inpriv.xyz",
  "https://temp.inpriv.xyz",
  "https://id.inpriv.xyz",
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

export const bad = (msg, status = 400) => json({ error: msg }, status);

export function corsFor(req) {
  const o = req.headers.get("Origin") || "";
  if (ORIGINS.has(o) || /^https:\/\/[a-z0-9-]+\.inpriv\.xyz$/.test(o)) {
    return {
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "X-Inpriv-Token",
      Vary: "Origin",
    };
  }
  return {};
}

// ── password hashing (PBKDF2-SHA256, chained) ───────────────────────────────
// Cloudflare caps deriveBits at 100 000 iterations per call, so we chain
// 3 rounds × 100 000 = 300 000 effective iterations (OWASP-class work).
// pass_iters stored per-user = total nominal iterations (must be a multiple
// of 100 000 for verification to replay the same chain).
const PBKDF2_CAP = 100_000;

export async function passHash(password, saltB64, iters = PASS_ITERS) {
  const rounds = Math.max(1, Math.floor(iters / PBKDF2_CAP));
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

export function constantTimeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

// ── base32 + TOTP (RFC 6238, SHA-1, 6 digits, ±1 step) ─────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

async function hotp(secretBytes, counter) {
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

export async function verifyTOTP(code, secretBytes, atMs) {
  const step = Math.floor(atMs / 30_000);
  for (let w = -1; w <= 1; w++) {
    if (constantTimeEq(await hotp(secretBytes, step + w), code)) return true;
  }
  return false;
}

// ── rate limiting (D1 counters) ─────────────────────────────────────────────
export async function rateLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(now() / windowMs);
  const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
  if (row && row.c >= limit) return false;
  await db
    .prepare("INSERT INTO rl_counters (k, bucket, c) VALUES (?,?,1) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
    .bind(key, bucket)
    .run();
  return true;
}

// ── request context ─────────────────────────────────────────────────────────
export function parseUA(ua) {
  const s = String(ua || "");
  let browser = "Unknown";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\//.test(s)) browser = "Opera";
  else if (/Chrome\//.test(s) && !/Chromium|Edg|OPR/.test(s)) browser = "Chrome";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  let os = "Unknown OS";
  if (/Windows/.test(s)) os = "Windows";
  else if (/Android/.test(s)) os = "Android";
  else if (/iPhone|iPad/.test(s)) os = "iOS";
  else if (/Mac OS X/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";
  return `${browser} · ${os}`;
}

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

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; Secure; HttpOnly; SameSite=None; Partitioned`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`;
}
