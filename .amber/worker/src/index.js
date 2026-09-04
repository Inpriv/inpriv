// Inpriv Amber — Cloudflare Worker
// Personal web archive: capture pages (HTML + subpages + assets) into a ZIP,
// store snapshots on Google Drive (user OAuth), browse by date, view offline.
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// Storage layout on Drive (folder "inpriv/.amber"):
//   snap_<id>.zip            — full snapshot archive
//   idx_<id>.txt             — search index (one lowercase token per line)
// D1 keeps only metadata. Snapshots belong to a signed-in Inpriv ID account.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";
import { driveToken, driveFolder, kvPut, kvDelete, kvGet, kvDeleteId } from "../../../common/drive.js";
import { passHash, constantTimeEq } from "../../../.id/worker/src/lib.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const PASS_ITERS = 300_000;
const PASS_ITERS_LITE = 10_000; // anti-enumeration burn (unknown user)
const MAX_ZIP = 40 * 1024 * 1024;      // stay under the 48 MB drive-kv margin
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_SUBPAGES = 3;
const MAX_ASSETS = 40;
const QUOTA_FALLBACK = 512 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 InprivAmber/1.0";

// ── small helpers ────────────────────────────────────────────────────────────
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randB64 = (n) => b64(crypto.getRandomValues(new Uint8Array(n)));
const newSnapId = () => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(12))) s += a[b % a.length];
  return s;
};

async function rateLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
  if (row && row.c >= limit) return false;
  await db
    .prepare("INSERT INTO rl_counters (k, bucket, c) VALUES (?,?,1) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
    .bind(key, bucket)
    .run();
  return true;
}

const ipPrefix = (request) =>
  (request.headers.get("CF-Connecting-IP") || "x").split(".").slice(0, 2).join(".");

// ── URL normalization + SSRF guard ───────────────────────────────────────────
function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    // a foreign scheme (ftp:, file:, javascript:, …) is never a capture target;
    // "host:port" without a scheme is fine and gets https:// prepended
    if (/^(ftp|file|data|javascript|mailto|tel|ws|wss|gopher|about|blob|chrome):/i.test(s)) return null;
    s = "https://" + s;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u;
}
const urlKey = (u) => u.origin + u.pathname + u.search;

function isForbiddenHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "0.0.0.0") return true;
  if (h === "metadata.google.internal" || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
  }
  if (h.startsWith("[") && /^\[f[cd]|^\[fe80/i.test(h)) return true; // IPv6 ULA/link-local
  return false;
}

// fetch with the SSRF guard — throws on disallowed targets
async function ssrfFetch(url, extra = {}) {
  const u = new URL(url);
  if (isForbiddenHost(u.hostname)) throw new Error("blocked-host");
  return fetch(u.toString(), {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "*/*", ...(extra.headers || {}) },
  });
}

// ── HTML rewriting (archive:// URLs) ─────────────────────────────────────────
const ARCHIVE_SCHEME = "archive://";
// In-zip path: "host/sanitized/path" — host keeps different origins apart.
// Assets (isAsset=true) with a query string get a short query hash appended
// when the pathname has no extension — "fonts.googleapis.com/css2" URLs for
// different families must not collide inside the ZIP.
function pathKey(absUrl, isAsset) {
  let p, hostL, hasExt, q = "";
  try {
    const u = new URL(absUrl);
    hostL = u.host.toLowerCase();
    hasExt = /\.[a-z0-9]{1,5}$/i.test(u.pathname);
    q = u.search || "";
    p = (hostL + "/" + decodeURIComponent(u.pathname)).replace(/\/+/g, "/");
    p = p.replace(/\/+$/, "");
    if (p === hostL) p += "/index";
  } catch { return "invalid"; }
  if (isAsset && q && !hasExt) {
    p += "_" + qhash(q);
    // extension-less stylesheets (Google Fonts css2!) must keep a .css name,
    // otherwise the viewer serves them as octet-stream and fonts never load
    if (/(^|\.)fonts\.googleapis\.(com|cn)$/.test(hostL) || /family=|\/css/i.test(q)) p += ".css";
  }
  return p.replace(/[^\w.\-~/@+,=!&;()'%]/g, "_");
}
// deterministic 6-char hash (pure, stable across isolates/deploys)
function qhash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, "0").slice(0, 6);
}
function resolveAbs(absBase, href) {
  try {
    const u = new URL(href, absBase);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch { return null; }
}

// (rewriteHtml lives in the capture section below — archive-namespace rewriter)

// Plain-text extraction for search indexing (tags stripped, entities kept low-tech)
function extractText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .slice(0, 40000);
}
function buildIndex(chunks) {
  const stop = new Set("the a an and or of to in for on with is are was were be been at as by it its from this that these those you your we our they their he she his her not no but if then else when while all any can will just about into over under more most other some such only own same than too very s t don now".split(" "));
  const set = new Set();
  for (const chunk of chunks) {
    for (const w of String(chunk || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,30}/g) || []) {
      if (w.length >= 2 && !stop.has(w)) set.add(w);
    }
  }
  return [...set].slice(0, 12000).join("\n");
}

// ── minimal ZIP (store, no compression) ──────────────────────────────────────
const table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = ~0;
  for (let i = 0; i < u8.length; i++) c = table[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function buildZip(files) {
  // files: [{ name, data: Uint8Array }] — paths use "/"
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          // version needed
    lh.setUint16(6, 0, true);           // flags
    lh.setUint16(8, 0, true);           // method: store
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)], { type: "application/zip" });
}

// ── Drive storage (binary ZIP + index via drive-kv) ──────────────────────────
const zipNameFor = (id) => `snap_${id}.zip`;

async function driveUploadBinary(env, name, blob) {
  const folder = await driveFolder(env);
  const token = await driveToken(env);
  const boundary = "ip" + crypto.randomUUID().replace(/-/g, "");
  const meta = JSON.stringify({ name, parents: [folder] });
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": `multipart/related; boundary=${boundary}` },
      body: new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        blob,
        `\r\n--${boundary}--\r\n`,
      ]),
    }
  );
  if (!res.ok) throw new Error("drive_upload_failed: " + res.status + " " + (await res.text()).slice(0, 150));
  return (await res.json()).id;
}

async function driveGetBinary(env, fileId) {
  const token = await driveToken(env);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: "Bearer " + token },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("drive_download_failed: " + res.status);
  return res;
}

// ── content-type by extension (serving archive assets) ───────────────────────
const CT_MAP = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript", mjs: "text/javascript",
  json: "application/json", txt: "text/plain; charset=utf-8", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  wav: "audio/wav", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  pdf: "application/pdf",
};
const ctFor = (path) => {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:$|\?)/);
  return (m && CT_MAP[m[1]]) || "application/octet-stream";
};

// ── auth (Inpriv ID password login + SSO grant, Host pattern) ────────────────
// Sessions work BOTH as Bearer (SPA fetch) and as an HttpOnly cookie — the
// archive viewer loads archived pages via plain iframe navigations, which
// cannot attach Authorization headers.
const COOKIE = "amber_session";

async function sessionToken(request) {
  const h = request.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)amber_session=([^;]+)/);
  return m ? m[1].trim() : "";
}

async function authed(request, env, cors, handler) {
  const token = await sessionToken(request);
  if (!token) return json({ error: "unauthorized" }, 401, cors);
  const sid = await sha256hex(token);
  const row = await env.DB.prepare(
    "SELECT expires_at, user_id AS uid, username, nick FROM sessions WHERE id = ?"
  ).bind(sid).first();
  if (!row || row.expires_at < Date.now()) return json({ error: "unauthorized" }, 401, cors);
  return handler({ uid: row.uid, user: { id: row.uid, username: row.username || "", nick: row.nick || row.username || "user" } });
}

async function syncIdConsent(env, uid, username) {
  try {
    if (!env.ID_DB || !uid || !username) return;
    const ts = Date.now();
    const row = await env.ID_DB.prepare(
      "SELECT last_used FROM consents WHERE user_id = ? AND service = ?"
    ).bind(uid, "amber").first();
    if (row && row.last_used && ts - row.last_used < 3_600_000) return; // ≤1 write/h
    await env.ID_DB.prepare(
      "INSERT INTO consents (user_id, service, granted_at, last_used) VALUES (?,?,?,?) " +
      "ON CONFLICT(user_id, service) DO UPDATE SET last_used = excluded.last_used"
    ).bind(uid, "amber", ts, ts).run();
  } catch { /* best-effort */ }
}

const sessionCookie = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;

async function login(request, env, cors, ctx) {
  const body = await request.json().catch(() => ({}));
  const input = String(body.user || "").trim().toLowerCase();
  const password = String(body.password || "");
  const totp = String(body.totp || "").trim();
  if (!input || !password) return bad("Enter your username and password");

  const rkey = "amberlogin:" + ipPrefix(request);
  if (!(await rateLimit(env.DB, rkey, 10, 15 * 60_000)))
    return bad("Too many attempts — try again in 15 minutes", 429);

  const local = input.split("@")[0];
  const idu = await env.ID_DB.prepare(
    "SELECT id, username, nick, pass_hash, pass_salt, pass_iters, totp_enabled FROM users WHERE username IN (?, ?) OR email IN (?, ?) OR recovery_email IN (?, ?) LIMIT 1"
  ).bind(local, input, local + "@inpriv.xyz", input, input, local + "@inpriv.xyz").first();

  // anti-enumeration: burn PBKDF2 work even when the user doesn't exist
  let ok = false;
  if (idu && idu.pass_hash) {
    const cand = await passHash(password, idu.pass_salt, idu.pass_iters);
    ok = constantTimeEq(cand, idu.pass_hash);
  } else {
    await passHash(password, b64(crypto.getRandomValues(new Uint8Array(16))), PASS_ITERS_LITE);
  }
  if (!idu || !ok) return bad("Invalid credentials", 401);

  // TOTP stays sealed in ID's vault — delegate verification to ID's endpoint
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

  const token = randB64(32);
  const sid = await sha256hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, username, nick, created_at, expires_at) VALUES (?,?,?,?,?,?)"
  ).bind(sid, idu.id, idu.username, idu.nick || idu.username, Date.now(), Date.now() + SESSION_TTL).run();
  ctx.waitUntil(syncIdConsent(env, idu.id, idu.username));
  return json({ token, user: { id: idu.id, username: idu.username, nick: idu.nick || idu.username } }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function ssoLogin(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const grant = String(body.grant || "");
  const state = String(body.state || "");
  if (!grant) return bad("Missing sign-in grant");
  const rkey = "ambersso:" + ipPrefix(request);
  if (!(await rateLimit(env.DB, rkey, 20, 15 * 60_000)))
    return bad("Too many attempts — try again in 15 minutes", 429);
  if (!env.SERVICE_KEY) return bad("SSO not configured", 503);

  const r = await fetch("https://id.inpriv.xyz/api/grant/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Inpriv-Service": env.SERVICE_KEY },
    body: JSON.stringify({ grant, service: "amber" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) return bad((d && d.error) || "Sign-in grant rejected", 401);
  if (state && d.state && state !== d.state) return bad("Grant mismatch", 401);
  if (d.totp_required || d.totp_enabled)
    return json({ totp_required: true, username: d.user && d.user.username }, 200, cors);

  const token = randB64(32);
  const sid = await sha256hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, username, nick, created_at, expires_at) VALUES (?,?,?,?,?,?)"
  ).bind(sid, d.user.id, d.user.username, d.user.nick || d.user.username, Date.now(), Date.now() + SESSION_TTL).run();
  return json({ token, user: { id: d.user.id, username: d.user.username, nick: d.user.nick || d.user.username } }, 200, { "Set-Cookie": sessionCookie(token) });
}

// ── capture engine ───────────────────────────────────────────────────────────
// Pages are stored with ALL links rewritten to same-origin archive URLs
// (/a/<snapId>/<path>) and served with a `CSP: sandbox` header: archived
// pages live in an opaque origin, scripts are stripped at capture time, so
// third-party code can never touch the Amber session.

const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|css|js|mjs|json|txt|xml|pdf|mp4|webm|mp3|wav|woff2?|ttf|otf)(\?|$)/i;
const archiveRef = (snapId, inZipPath) => `/a/${snapId}/${inZipPath}`;

// Rewrite url(...) refs inside CSS. absBase is the REAL absolute stylesheet
// URL (relative refs resolve against it, so the host is never lost).
// Returns { text, absUrls }.
function cssRewrite(text, snapId, absBase) {
  const absUrls = new Set();
  const out = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q, raw) => {
    if (!raw || /^(data|blob|about:|#)/i.test(raw) || raw.startsWith("/a/")) return m;
    let abs;
    try { abs = new URL(raw, absBase); } catch { return m; }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return m;
    absUrls.add(abs.toString());
    return `url(${archiveRef(snapId, pathKey(abs.toString()))})`;
  });
  return { text: out, absUrls: [...absUrls] };
}

// Rewrite an HTML document: strip scripts, map asset/page refs onto the
// archive namespace, rewrite inline <style> blocks and srcset candidates.
// Returns { html, refs, assetRefs } — refs = page navigations, assetRefs =
// asset URLs (stylesheets, images, icons — whatever gets an /a/…/ path).
function rewriteHtml(text, snapId, pagePath, pageAbs) {
  const refs = new Set();
  const assetRefs = new Set();
  let src = text
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/ on[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, ""); // inline handlers are dead without scripts

  const styleBlocks = [];
  src = src.replace(/(<style[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) => {
    const { text: rw } = cssRewrite(css, snapId, pageAbs);
    styleBlocks.push(1);
    return open + rw + close;
  });

  // <link rel="stylesheet|icon|manifest|preload"> point at ASSETS even though
  // their URLs often have no file extension (Google Fonts css2!, favicon).
  // preconnect/dns-prefetch point at bare origins — neutralize to "#".
  src = src.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\bhref\s*=/i.test(tag)) return tag;
    const relM = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i);
    const rel = ((relM && (relM[1] || relM[2] || relM[3])) || "").toLowerCase();
    if (/preconnect|dns-prefetch/.test(rel)) return tag.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+)/i, 'href="#"');
    if (!/stylesheet|icon|apple-touch|manifest|preload|shortcut/.test(rel)) return tag;
    return tag.replace(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i, (hm, dq2, sq2, uq2) => {
      const raw = dq2 !== undefined ? dq2 : (sq2 !== undefined ? sq2 : uq2);
      if (!raw || raw.startsWith("#") || /^(data|blob|javascript|mailto|tel|about):/i.test(raw)) return hm;
      const u = resolveAbs(pageAbs, raw);
      if (!u) return hm;
      refs.add(u.toString());
      assetRefs.add(u.toString());
      const quote = dq2 !== undefined ? '"' : (sq2 !== undefined ? "'" : '"');
      return `href=${quote}${archiveRef(snapId, pathKey(u.toString(), true))}${quote}`;
    });
  });

  src = src.replace(/\s(src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi, (m, attr, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : (sq !== undefined ? sq : uq);
    if (!raw || raw.startsWith("/a/") || raw.startsWith("#") || /^(data|blob|javascript|mailto|tel|about|sms):/i.test(raw)) return m;
    const u = resolveAbs(pageAbs, raw);
    if (!u) return m;
    refs.add(u.toString());
    const quote = dq !== undefined ? '"' : (sq !== undefined ? "'" : '"');
    const low = attr.toLowerCase();
    if (low === "href" && !ASSET_EXT_RE.test(u.pathname + u.search)) {
      // page navigation — resolved against snap_pages at view time
      return ` ${attr}=${quote}${archiveRef(snapId, pathKey(u.toString()))}${quote} data-orig="${u.origin + u.pathname}"`;
    }
    assetRefs.add(u.toString());
    return ` ${attr}=${quote}${archiveRef(snapId, pathKey(u.toString(), true))}${quote}`;
  });

  src = src.replace(/\ssrcset\s*=\s*"([^"]*)"/gi, (m, val) => {
    const parts = val.split(",").map((cand) => {
      const seg = cand.trim().split(/\s+/);
      const u = resolveAbs(pageAbs, seg[0] || "");
      if (!u) return cand;
      refs.add(u.toString());
      assetRefs.add(u.toString());
      return `${archiveRef(snapId, pathKey(u.toString(), true))}${seg[1] ? " " + seg.slice(1).join(" ") : ""}`;
    });
    return ` srcset="${parts.join(", ")}"`;
  });
  return { html: src, refs, assetRefs };
}

// Capture startAbs (+ up to MAX_SUBPAGES same-origin subpages + assets).
async function captureSite(snap, startAbs) {
  const files = new Map();   // in-zip path -> Uint8Array
  const pageRows = [];       // { url, path, title, text }
  const seen = new Set();
  let total = 0, assetCount = 0;

  const addFile = (name, data) => { if (!files.has(name)) files.set(name, data); };

  const fetchAsset = async (absUrl) => {
    const key = urlKey(new URL(absUrl));
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const res = await ssrfFetch(absUrl);
      if (!res.ok) return;
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_ASSET_BYTES) return;
      total += buf.length;
      if (total > MAX_ZIP) throw new Error("too-big");
      const fin = res.url || absUrl;
      // extension-less stylesheets (Google's /_/ss/…, fonts css2!) must keep a
      // .css name — the viewer serves by extension, octet-stream CSS is dead
      let finPath = pathKey(fin, true);
      if (/css/i.test(ct) && !/\.[a-z0-9]{1,5}$/i.test(finPath)) finPath += ".css";
      if (/css/i.test(ct) || /\.css($|\?)/i.test(new URL(fin).pathname)) {
        const txt = new TextDecoder("utf-8").decode(buf);
        const { text: rw, absUrls } = cssRewrite(txt, snap.id, fin);
        addFile(finPath, new TextEncoder().encode(rw));
        for (const a of absUrls) queueAsset(a);
      } else {
        addFile(finPath, buf);
      }
      assetCount++;
    } catch (e) {
      if (String(e && e.message) === "too-big") throw e;
    }
  };

  const assetQueue = [];
  const queueAsset = (abs) => {
    try {
      const u = new URL(abs);
      if (isForbiddenHost(u.hostname)) return;
      const k = urlKey(u);
      if (!seen.has(k) && assetQueue.length < 300) assetQueue.push(u.toString());
    } catch {}
  };

  // ── main page ──
  const startU = new URL(startAbs);
  seen.add(urlKey(startU));
  const mainRes = await ssrfFetch(startAbs);
  if (!mainRes.ok && mainRes.status !== 200) throw new Error("fetch-failed: " + mainRes.status);
  const mainCt = mainRes.headers.get("content-type") || "";
  const mainFinal = mainRes.url || startAbs;
  const mainBuf = new Uint8Array(await mainRes.arrayBuffer());
  if (mainBuf.length > MAX_PAGE_BYTES) throw new Error("too-big");
  total += mainBuf.length;

  let title = null;
  const titleFrom = (html) => {
    const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
    return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) : null;
  };

  if (mainCt.includes("html") || (!mainCt && mainBuf.length && !mainBuf.slice(0, 400).includes(0))) {
    // HTML main page (+ subpages)
    let html = new TextDecoder("utf-8").decode(mainBuf);
    title = titleFrom(html);
    const mainPath = pathKey(mainFinal);
    const { html: mainRw, refs: mainRefsSet, assetRefs: mainAssetRefs } = rewriteHtml(html, snap.id, mainPath, mainFinal);
    addFile(mainPath, new TextEncoder().encode(mainRw));
    pageRows.push({ url: urlKey(new URL(mainFinal)), path: mainPath, title, text: extractText(html) });

    // assets discovered by the rewriter go FIRST (it knows exactly which refs
    // are assets — no extension guessing) — the 40-asset cap can never drop
    // stylesheets in favour of images
    for (const r of mainAssetRefs) {
      const u = new URL(r);
      if (!isForbiddenHost(u.hostname)) queueAsset(u.toString());
    }

    // breadth-first subpage walk (same-host only, capped)
    const pageQueue = [];
    const pageQueued = new Set();
    const consider = (absStr) => {
      const u = new URL(absStr);
      if (u.hostname !== startU.hostname || isForbiddenHost(u.hostname)) return;
      if (ASSET_EXT_RE.test(u.pathname)) { queueAsset(absStr); return; }
      const k = urlKey(u);
      if (seen.has(k) || pageQueued.has(k)) return;
      if (pageQueue.length >= MAX_SUBPAGES) return;
      pageQueued.add(k);
      pageQueue.push(u.toString());
    };
    for (const r of mainRefsSet) consider(r);

    while (pageQueue.length && pageRows.length < 1 + MAX_SUBPAGES) {
      const abs = pageQueue.shift();
      const key = urlKey(new URL(abs));
      if (seen.has(key)) continue;
      seen.add(key);
      let subHtml = null, subFin = abs;
      try {
        const res = await ssrfFetch(abs);
        if (res.ok) {
          const rct = res.headers.get("content-type") || "";
          const b = new Uint8Array(await res.arrayBuffer());
          if (b.length <= MAX_PAGE_BYTES && total + b.length <= MAX_ZIP) {
            total += b.length;
            if (rct.includes("html")) { subHtml = new TextDecoder("utf-8").decode(b); subFin = res.url || abs; }
            else if (ASSET_EXT_RE.test(new URL(res.url || abs).pathname)) { queueAsset(res.url || abs); continue; }
          }
        }
      } catch {}
      if (subHtml == null) continue;
      const subPath = pathKey(subFin);
      const { html: subRw, refs, assetRefs: subAssets } = rewriteHtml(subHtml, snap.id, subPath, subFin);
      addFile(subPath, new TextEncoder().encode(subRw));
      pageRows.push({ url: key, path: subPath, title: titleFrom(subHtml), text: extractText(subHtml) });
      for (const a of subAssets) queueAsset(a);
      for (const r of refs) consider(r);
    }
  } else {
    // non-HTML target — single-file snapshot
    const p = pathKey(mainFinal);
    addFile(p, mainBuf);
    title = decodeURIComponent((new URL(mainFinal).pathname.split("/").pop() || "file")).slice(0, 200);
    pageRows.push({ url: urlKey(new URL(mainFinal)), path: p, title, text: "" });
  }

  // ── drain the asset queue ──
  while (assetQueue.length && assetCount < MAX_ASSETS && total < MAX_ZIP) {
    await fetchAsset(assetQueue.shift());
  }

  if (!files.size) throw new Error("nothing-captured");

  const zip = buildZip([...files].map(([name, data]) => ({ name: "site/" + name, data })));
  if (zip.size > MAX_ZIP) throw new Error("too-big");
  return {
    zip,
    title,
    finalUrl: mainFinal,
    pages: pageRows.length,
    assets: Math.max(0, files.size - pageRows.length),
    text: pageRows.map((p) => p.text).join("\n"),
    pageRows,
  };
}

async function runCapture(env, snap) {
  try {
    const r = await captureSite(snap, snap.url);
    const driveId = await driveUploadBinary(env, zipNameFor(snap.id), r.zip);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE snapshots SET status='ok', drive_file_id=?, size_bytes=?, title=?, final_url=?, pages=?, assets=? WHERE id=?"
      ).bind(driveId, r.zip.size, r.title, r.finalUrl, r.pages, r.assets, snap.id),
      ...r.pageRows.map((p) =>
        env.DB.prepare("INSERT OR IGNORE INTO snap_pages (snap_id, url, path) VALUES (?,?,?)").bind(snap.id, p.url, p.path)
      ),
    ]);
    try { await kvPut(env, `idx_${snap.id}.txt`, buildIndex([r.text, r.title || "", snap.host])); } catch {}
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 200);
    try {
      await env.DB.prepare("UPDATE snapshots SET status='failed', error=? WHERE id=?").bind(msg, snap.id).run();
    } catch {}
    return { ok: false, error: msg };
  }
}

// ── ZIP entry extraction (read-only; our archives are STORE-method) ──────────
function zipExtractEntry(buf, wantName) {
  if (!wantName) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  const base = eocd - (cdSize + cdOff); // > 0 only with a prepended preamble
  const cd = (base > 0 ? base : 0) + cdOff;
  const td = new TextDecoder();
  let p = cd;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (name === wantName || name === "site/" + wantName) {
      if (method !== 0) return null; // stored-only archives (Amber never deflates)
      const lhNameLen = dv.getUint16(base + lho + 26, true);
      const lhExtraLen = dv.getUint16(base + lho + 28, true);
      const start = base + lho + 30 + lhNameLen + lhExtraLen;
      return buf.slice(start, start + compSize);
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  return null;
}

// ── silent auth (viewer routes: null instead of a 401 Response) ──────────────
async function whoami(request, env) {
  const token = await sessionToken(request);
  if (!token) return null;
  const sid = await sha256hex(token);
  const row = await env.DB.prepare(
    "SELECT expires_at, user_id AS uid, username, nick FROM sessions WHERE id = ?"
  ).bind(sid).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { uid: row.uid, user: { id: row.uid, username: row.username || "", nick: row.nick || row.username || "user" } };
}

// ── archive viewer (session cookie — iframe navigations can't send Bearer) ──
const ARCHIVE_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline' data: https://amber.inpriv.xyz; " +
  "img-src 'unsafe-inline' data: blob: https://amber.inpriv.xyz; " +
  "font-src data: https://amber.inpriv.xyz; media-src data: https://amber.inpriv.xyz; " +
  "frame-ancestors https://amber.inpriv.xyz";

async function serveArchive(request, env, snapId, innerPath) {
  const me = await whoami(request, env);
  if (!me) return new Response("Sign in to view archived pages", { status: 401, headers: { "Content-Type": "text/plain" } });
  const snap = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(snapId).first();
  if (!snap || snap.user_id !== me.uid) return new Response("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  if (snap.status !== "ok" || !snap.drive_file_id)
    return new Response("This snapshot is not available (status: " + snap.status + ")", { status: 409, headers: { "Content-Type": "text/plain" } });

  const wanted = decodeURIComponent(innerPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
  let inner = wanted || "index";
  const res = await driveGetBinary(env, snap.drive_file_id);
  if (!res) return new Response("Snapshot data missing from storage", { status: 410, headers: { "Content-Type": "text/plain" } });
  const zipBuf = new Uint8Array(await res.arrayBuffer());
  let data = zipExtractEntry(zipBuf, inner);
  // extension-less assets are stored with a ".css" suffix (added at capture
  // time when the content-type said stylesheet) — retry with the suffix
  let cssSuffixed = false;
  if (!data && !/\.[a-z0-9]{1,5}$/i.test(inner)) {
    data = zipExtractEntry(zipBuf, inner + ".css");
    if (data) cssSuffixed = true;
  }
  // pages captured without a file extension (e.g. "example.com/index") must
  // render as HTML — snap_pages is the authority on what is a page
  let forceHtml = false;
  if (!cssSuffixed && !/\.[a-z0-9]{1,5}$/i.test(inner)) {
    forceHtml = !!(await env.DB.prepare("SELECT 1 AS x FROM snap_pages WHERE snap_id = ? AND path = ?")
      .bind(snapId, inner).first());
  }
  if (!data && !wanted) data = zipExtractEntry(zipBuf, ""); // bare single-file snapshot
  if (!data) {
    // uncaptured navigation — show which pages ARE in this snapshot
    const rows = await env.DB.prepare("SELECT path, url FROM snap_pages WHERE snap_id = ? LIMIT 40").bind(snapId).all();
    const links = (rows.results || [])
      .map((r) => `<li><a href="/a/${snapId}/${r.path.replace(/^\/+/, "")}">${r.url.replace(/^https?:\/\//, "")}</a></li>`)
      .join("");
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not captured</title><body style="font-family:system-ui,sans-serif;background:#13140E;color:#E3E2D3;max-width:34rem;margin:8vh auto 0;padding:0 1.25rem;line-height:1.6"><h1 style="font-weight:300;font-size:1.4rem">Not captured in this snapshot</h1><p style="color:#C3C8B6">This page was linked from the captured site but wasn't included in the archive. Pages available in this snapshot:</p><ul style="padding-left:1.2rem">${links || "<li>Main page only</li>"}</ul><p><a href="/" style="color:#ABD37A">Back to Amber</a></p></body>`,
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" } }
    );
  }
  const isHtml = forceHtml || /\.html?$/i.test(inner) || ctFor(inner).startsWith("text/html");
  const finalCt = cssSuffixed ? "text/css; charset=utf-8" : (isHtml ? "text/html; charset=utf-8" : ctFor(inner));
  const headers = {
    "Content-Type": finalCt,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "private, max-age=300",
  };
  if (isHtml || ctFor(inner) === "image/svg+xml" || ctFor(inner).endsWith("css")) headers["Content-Security-Policy"] = ARCHIVE_CSP;
  return new Response(data, { headers });
}

// ── API handlers ─────────────────────────────────────────────────────────────
async function startCapture(request, env, cors, me, ctx) {
  const body = await request.json().catch(() => ({}));
  const u = normalizeUrl(body.url);
  if (!u) return bad("Enter a valid URL");
  if (isForbiddenHost(u.hostname)) return bad("That host is not allowed");
  if (!(await rateLimit(env.DB, "cap:" + me.uid, 30, 3600_000)))
    return bad("Capture limit reached (30/hour) — try again later", 429);

  const used = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes),0) AS used FROM snapshots WHERE user_id = ? AND status = 'ok'"
  ).bind(me.uid).first();
  const quota = Number(env.QUOTA_BYTES || QUOTA_FALLBACK);
  if (Number(used.used) >= quota) return bad("Storage quota full — delete some snapshots first", 403);

  const key = urlKey(u);
  const host = u.hostname.toLowerCase();
  const now = Date.now();
  let site = await env.DB.prepare("SELECT id FROM sites WHERE user_id = ? AND host = ? AND url = ?")
    .bind(me.uid, host, key).first();
  if (!site) {
    const r = await env.DB.prepare("INSERT INTO sites (user_id, url, host, created_at) VALUES (?,?,?,?)")
      .bind(me.uid, key, host, now).run();
    site = { id: r.meta.last_row_id };
  }
  const id = newSnapId();
  const snap = { id, site_id: site.id, user_id: me.uid, url: key, host, created_at: now };
  await env.DB.prepare(
    "INSERT INTO snapshots (id, site_id, user_id, url, host, status, created_at) VALUES (?,?,?,?,?, 'queued', ?)"
  ).bind(id, site.id, me.uid, key, host, now).run();
  ctx.waitUntil(runCapture(env, snap));
  return json({ id, status: "queued", site_id: site.id });
}

async function recapture(request, env, cors, me, ctx, snapId) {
  const snap = await env.DB.prepare("SELECT id, site_id, user_id, url, host, created_at FROM snapshots WHERE id = ?").bind(snapId).first();
  if (!snap || snap.user_id !== me.uid) return bad("Snapshot not found", 404);
  if (!(await rateLimit(env.DB, "cap:" + me.uid, 30, 3600_000)))
    return bad("Capture limit reached (30/hour) — try again later", 429);
  const old = await env.DB.prepare("SELECT drive_file_id FROM snapshots WHERE id = ?").bind(snapId).first();
  await env.DB.prepare("DELETE FROM snap_pages WHERE snap_id = ?").bind(snapId).run();
  await env.DB.prepare(
    "UPDATE snapshots SET status='queued', error=NULL, drive_file_id=NULL, size_bytes=0, title=NULL, final_url=NULL, pages=1, assets=0, created_at=? WHERE id=?"
  ).bind(Date.now(), snapId).run();
  if (old && old.drive_file_id) {
    try { await kvDeleteId(env, old.drive_file_id); } catch {}
    try { await kvDelete(env, `idx_${snapId}.txt`); } catch {}
  }
  ctx.waitUntil(runCapture(env, snap));
  return json({ id: snapId, status: "queued" });
}

async function listSites(request, env, cors, me) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const rows = await env.DB.prepare(
    "SELECT s.id AS site_id, s.url, s.host, " +
    "(SELECT COUNT(*) FROM snapshots k WHERE k.site_id = s.id AND k.status='ok') AS snap_count, " +
    "(SELECT MAX(created_at) FROM snapshots k WHERE k.site_id = s.id AND k.status='ok') AS last_at " +
    "FROM sites s WHERE s.user_id = ?1 ORDER BY last_at DESC LIMIT 500"
  ).bind(me.uid).all();
  let sites = rows.results || [];
  if (q) {
    const toks = q.match(/[a-z0-9][a-z0-9'-]{1,30}/g) || [];
    // SQL pass: title/host/url matches via LIKE on any token
    const like = toks.map(() => "host LIKE ? OR url LIKE ?").join(" OR ");
    const params = [];
    for (const t of toks) { params.push("%" + t + "%", "%" + t + "%"); }
    const hits = new Set();
    try {
      const r2 = await env.DB.prepare(
        `SELECT DISTINCT k.site_id, k.title FROM snapshots k WHERE k.user_id = ?1 AND k.status='ok' AND (${like})`
      ).bind(me.uid, ...params).all();
      for (const r of r2.results || []) hits.add(r.site_id);
    } catch {}
    // index pass (page text): capped parallel scan
    if (!hits.size) {
      const all = await env.DB.prepare(
        "SELECT id, site_id FROM snapshots WHERE user_id = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 120"
      ).bind(me.uid).all();
      const ids = all.results || [];
      const found = new Set();
      const BATCH = 12;
      for (let i = 0; i < ids.length && found.size < 40; i += BATCH) {
        const slice = ids.slice(i, i + BATCH);
        const results = await Promise.all(slice.map((s) => kvGet(env, `idx_${s.id}.txt`).catch(() => null)));
        results.forEach((txt, j) => {
          if (!txt) return;
          const t = txt.toLowerCase();
          if (toks.every((tk) => t.includes(tk))) found.add(slice[j].site_id);
        });
      }
      for (const sid of found) hits.add(sid);
    }
    sites = sites.filter((s) =>
      hits.has(s.site_id) || s.host.includes(q) || s.url.toLowerCase().includes(q)
    );
  }
  return json({ sites });
}

async function siteDetail(request, env, cors, me, _ctx, siteId) {
  const site = await env.DB.prepare("SELECT id, url, host, created_at FROM sites WHERE id = ? AND user_id = ?")
    .bind(siteId, me.uid).first();
  if (!site) return bad("Site not found", 404);
  const snaps = await env.DB.prepare(
    "SELECT id, status, title, size_bytes, pages, assets, error, created_at FROM snapshots WHERE site_id = ? ORDER BY created_at DESC"
  ).bind(siteId).all();
  return json({ site, snapshots: snaps.results || [] });
}

async function deleteSnap(request, env, cors, me, _ctx, snapId) {
  const snap = await env.DB.prepare("SELECT id, site_id, user_id, drive_file_id, status FROM snapshots WHERE id = ?")
    .bind(snapId).first();
  if (!snap || snap.user_id !== me.uid) return bad("Snapshot not found", 404);
  if (snap.drive_file_id) { try { await kvDeleteId(env, snap.drive_file_id); } catch {} }
  try { await kvDelete(env, `idx_${snapId}.txt`); } catch {}
  await env.DB.batch([
    env.DB.prepare("DELETE FROM snap_pages WHERE snap_id = ?").bind(snapId),
    env.DB.prepare("DELETE FROM snapshots WHERE id = ?").bind(snapId),
  ]);
  const left = await env.DB.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE site_id = ?").bind(snap.site_id).first();
  if (!left.c) await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(snap.site_id).run();
  return json({ ok: true });
}

async function downloadSnap(request, env, cors, me, _ctx, snapId) {
  const snap = await env.DB.prepare("SELECT user_id, drive_file_id, status, host, created_at FROM snapshots WHERE id = ?")
    .bind(snapId).first();
  if (!snap || snap.user_id !== me.uid) return bad("Snapshot not found", 404);
  if (snap.status !== "ok" || !snap.drive_file_id) return bad("Snapshot is not ready", 409);
  const res = await driveGetBinary(env, snap.drive_file_id);
  if (!res) return bad("Snapshot data missing from storage", 410);
  const d = new Date(snap.created_at).toISOString().slice(0, 10);
  return new Response(res.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="amber-${snap.host.replace(/[^a-z0-9.-]/gi, "_")}-${d}.zip"`,
      "X-Robots-Tag": "noindex",
    },
  });
}

async function meInfo(request, env, cors, me) {
  const used = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes),0) AS used, COUNT(*) AS snaps FROM snapshots WHERE user_id = ? AND status = 'ok'"
  ).bind(me.uid).first();
  const sites = await env.DB.prepare("SELECT COUNT(*) AS c FROM sites WHERE user_id = ?").bind(me.uid).first();
  return json({
    user: me.user,
    usage: {
      used_bytes: Number(used.used),
      quota_bytes: Number(env.QUOTA_BYTES || QUOTA_FALLBACK),
      snapshots: used.snaps,
      sites: sites.c,
    },
  });
}

// token→sites text search (page text via Drive indexes + SQL title/host pass)
async function search(request, env, cors, me) {
  return await listSites(request, env, cors, me);
}

// ── router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const cors = CORS;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // internal sweep endpoint (admin cron, shared secret — like Burn)
    if (method === "POST" && path === "/api/sweep") {
      const h = request.headers.get("X-Sweep-Secret") || "";
      if (!env.SWEEP_SECRET || h !== env.SWEEP_SECRET) return json({ error: "unauthorized" }, 401);
      const snaps = await env.DB.prepare(
        "SELECT id, drive_file_id FROM snapshots WHERE status = 'queued' AND created_at < ? LIMIT 100"
      ).bind(Date.now() - 30 * 60_000).all();
      let fixed = 0;
      for (const s of snaps.results || []) {
        const r = await runCapture(env, { id: s.id, site_id: 0, user_id: "", url: "", host: "", created_at: Date.now() });
        if (r.ok) fixed++;
      }
      return json({ ok: true, requeued: fixed });
    }

    // kill-switch gate (never blocks /api/health or archive reads)
    const gate = await maintenanceGate("amber");
    if (gate.locked && path !== "/api/health") return maintenancePage("Inpriv Amber", gate.message);

    if (path === "/api/health") {
      let drive = "off";
      try { await driveToken(env); drive = env.DRIVE_OAUTH ? "oauth" : "off"; }
      catch (e) { drive = String(e.message || e).split(":")[0]; }
      return json({ ok: true, service: "amber", drive, open: true, ts: Date.now() });
    }

    // ── archive viewer (cookie session; also plain /a/<id> root) ──
    const am = path.match(/^\/a\/([a-z0-9]{12})(?:\/(.*))?$/i);
    if (am && (method === "GET" || method === "HEAD")) {
      const inner = am[2] || "";
      if (!inner) {
        // snapshot root → redirect to the ENTRY page (the captured URL)
        const me0 = await whoami(request, env);
        if (!me0) return new Response("Sign in to view archived pages", { status: 401, headers: { "Content-Type": "text/plain" } });
        const snap0 = await env.DB.prepare("SELECT user_id, url FROM snapshots WHERE id = ?").bind(am[1]).first();
        if (!snap0 || snap0.user_id !== me0.uid) return new Response("Not found", { status: 404 });
        let row = await env.DB.prepare("SELECT path FROM snap_pages WHERE snap_id = ? AND url = ?")
          .bind(am[1], snap0.url).first();
        if (!row) row = await env.DB.prepare("SELECT path FROM snap_pages WHERE snap_id = ? LIMIT 1").bind(am[1]).first();
        return Response.redirect(`https://amber.inpriv.xyz/a/${am[1]}/${row && row.path ? row.path.replace(/^\/+/, "") : "index"}`, 302);
      }
      return serveArchive(request, env, am[1], inner);
    }

    // ── auth ──
    if (path === "/api/auth/login" && method === "POST") return await login(request, env, cors, ctx);
    if (path === "/api/auth/sso" && method === "POST") return await ssoLogin(request, env, cors);
    if (path === "/api/auth/logout" && method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0` });
    }

    // ── authed API ──
    if (path === "/api/me" && method === "GET")
      return await authed(request, env, cors, (me) => meInfo(request, env, cors, me));
    if (path === "/api/capture" && method === "POST")
      return await authed(request, env, cors, (me) => startCapture(request, env, cors, me, ctx));
    if (path === "/api/sites" && method === "GET")
      return await authed(request, env, cors, (me) => listSites(request, env, cors, me));
    if (path === "/api/search" && method === "GET")
      return await authed(request, env, cors, (me) => search(request, env, cors, me));
    if (path === "/api/snap/recapture" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      return await authed(request, env, cors, (me) => recapture(request, env, cors, me, ctx, String(body.id || "")));
    }
    if (path === "/api/snap/download" && method === "GET") {
      const sid = url.searchParams.get("id") || "";
      return await authed(request, env, cors, (me) => downloadSnap(request, env, cors, me, ctx, sid));
    }
    const snapDel = path.match(/^\/api\/snap\/([a-z0-9]{12})$/i);
    if (snapDel && method === "DELETE")
      return await authed(request, env, cors, (me) => deleteSnap(request, env, cors, me, ctx, snapDel[1]));
    const siteM = path.match(/^\/api\/site\/(\d+)$/);
    if (siteM && method === "GET")
      return await authed(request, env, cors, (me) => siteDetail(request, env, cors, me, ctx, siteM[1]));

    // ── static app ──
    if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) return notFound(request, "Inpriv Amber");
      return res;
    }

    return bad("Not found", 404);
  },
};
