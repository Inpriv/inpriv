// ═════════════════════════════════════════════════════════════════════════════
// Inpriv Host — worker (host.inpriv.xyz)
// Private static hosting on Google Drive with a privacy shield:
//   · chunked uploads → service-account Drive folder (files named by UUID)
//   · every HTML/text asset is scanned for IP loggers, WebRTC leak probes,
//     pixel beacons and tracker scripts BEFORE it is published
//   · public serving with sandbox + stealth headers, cached at the edge
//   · login via Inpriv ID (D1 cross-read — no password data stored here)
// Copyright (c) 2026 Aurex Labs — MIT License
// ═════════════════════════════════════════════════════════════════════════════

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import {
  PASS_ITERS, SESSION_TTL_MS,
  b64, uuid, sha256hex, json, bad, corsFor,
  passHash, constantTimeEq, verifyTOTP, base32Decode, rateLimit,
} from "../../../.id/worker/src/lib.js";

// ── config ───────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 100 * 1024 * 1024;         // 100 MB per file (signed-in)
const ANON_MAX_FILE_BYTES = 50 * 1024 * 1024;     // 50 MB per file (guest)
const USER_QUOTA_BYTES = 1 * 1024 * 1024 * 1024;  // 1 GB storage per account by default
const ANON_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;  // rolling 2 GB per guest (IP-prefix bucket)
const ANON_TTL_MS = 7 * 24 * 3600 * 1000;         // guest files expire after 7 days
// D1 rows are capped at ~2 MB — chunks MUST stay safely below that or the
// chunk PUT dies with SQLITE_TOOBIG. 1.5 MB keeps headroom for row overhead.
const CHUNK_BYTES = 1.5 * 1024 * 1024;            // 1.5 MB per chunk (client uses this)
const CHUNK_MAX = 2 * 1024 * 1024;                // 2 MB hard cap per chunk request
const CHUNK_MIN = 256 * 1024;                     // 256 KB
const MAX_FILES = 5000;
const TEXT_SCAN_LIMIT = 2 * 1024 * 1024;          // scan first 2 MB of text
const SERVE_CACHE_S = 6 * 3600;                   // edge cache for public files
const SESSION_TTL = SESSION_TTL_MS;
// limit-increase requests are delivered (encrypted) to this Inpriv Mail user
const ADMIN_MAIL_USER_ID = 4;                     // saloyek@inpriv.xyz
const CUSTOM_RE = /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/;
const CUSTOM_RESERVED = new Set([
  "www", "api", "admin", "login", "logout", "files", "file", "upload", "settings",
  "security", "about", "help", "support", "mail", "id", "app", "dashboard", "f", "s",
  "inpriv", "host", "static", "assets", "cdn", "js", "css", "img", "images",
]);

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg",
  wav: "audio/wav", ogg: "audio/ogg", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf",
  zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  tar: "application/x-tar", gz: "application/gzip",
};
// active content → forced download (never rendered inline from /f/)
const FORCE_DOWNLOAD = new Set(["html", "htm", "css", "js", "mjs", "svg", "xml", "pdf"]);
// text-like formats → full source scan + strict sandbox CSP
const SCANNABLE = new Set(["html", "htm", "css", "js", "mjs", "txt", "md", "json", "xml", "csv", "svg"]);

// ── router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const cors = corsFor(request);

    if (request.method === "OPTIONS") {
      if (request.body) request.body.cancel?.();
      return new Response(null, { status: 204, headers: cors });
    }

    // admin kill-switch (health always passes)
    const gate = await maintenanceGate("host");
    if (gate.locked && path !== "/api/health") {
      return maintenancePage("Inpriv Host", gate.message);
    }

    try {
      // public file serving  https://host.inpriv.xyz/f/<slug> or /s/<custom>
      if ((request.method === "GET" || request.method === "HEAD") && (path.startsWith("/f/") || path.startsWith("/s/"))) {
        return await servePublic(request, env, ctx, path);
      }

      // dashboard assets (single-file tool)
      if ((request.method === "GET" || request.method === "HEAD") && !path.startsWith("/api/")) {
        return harden(await env.ASSETS.fetch(request));
      }

      // ── API ──
      if (path === "/api/health") {
        let drive = "off";
        try { await getAccessToken(env); drive = env.DRIVE_OAUTH ? "oauth" : "sa"; } catch (e) { drive = String(e.message || e).split(":")[0]; }
        return json({ ok: true, service: "host", drive, open: true, ts: Date.now() });
      }
      if (path === "/api/auth/login" && request.method === "POST") return await login(request, env, cors);
      if (path === "/api/auth/logout" && request.method === "POST") return json({ ok: true }, 200, cors);
      if (path === "/api/pubkey" && request.method === "GET") return await adminPubKey(request, env, cors);

      if (path === "/api/me" && request.method === "GET")
        return authed(request, env, cors, async (me) => json({ user: pub(me.user), limits: await limitsFor(env, me.uid) }));
      if (path === "/api/files" && request.method === "GET")
        return authed(request, env, cors, (me) => listFiles(me, env, cors));
      if (path === "/api/upload/begin" && request.method === "POST")
        return authed(request, env, cors, (me) => beginUpload(request, me, env, cors));

      // anonymous (guest) uploads — open to everyone, files auto-expire in 7 days
      if (path === "/api/guest/upload/begin" && request.method === "POST") return await guestBegin(request, env, cors);
      let gm = path.match(/^\/api\/guest\/upload\/([a-zA-Z0-9-]+)\/(chunk|complete|abort)$/);
      if (gm && gm[2] === "chunk" && request.method === "PUT") return await guestChunk(url, request, gm[1], env, cors);
      if (gm && gm[2] === "complete" && request.method === "POST") return await guestComplete(gm[1], request, env, cors);
      if (gm && gm[2] === "abort" && request.method === "POST") return await guestAbort(gm[1], env, cors);
      if (path === "/api/guest/delete" && request.method === "POST") return await guestDelete(request, env, cors);

      let m = path.match(/^\/api\/upload\/([a-zA-Z0-9-]+)\/(chunk|complete|abort)$/);
      if (m && m[2] === "chunk" && request.method === "PUT")
        return authed(request, env, cors, (me) => putChunk(url, request, m[1], me, env, cors));
      if (m && m[2] === "complete" && request.method === "POST")
        return authed(request, env, cors, (me) => completeUpload(m[1], me, env, cors));
      if (m && m[2] === "abort" && request.method === "POST")
        return authed(request, env, cors, (me) => abortUpload(m[1], me, env, cors));

      m = path.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/visibility$/);
      if (m && request.method === "POST")
        return authed(request, env, cors, (me) => setVisibility(m[1], request, me, env, cors));
      m = path.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/custom$/);
      if (m && request.method === "POST")
        return authed(request, env, cors, (me) => setCustomSlug(m[1], request, me, env, cors));
      m = path.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/content$/);
      if (m && request.method === "GET")
        return authed(request, env, cors, (me) => servePrivate(m[1], me, env, cors));
      m = path.match(/^\/api\/files\/([a-zA-Z0-9-]+)$/);
      if (m && request.method === "DELETE")
        return authed(request, env, cors, (me) => deleteFile(m[1], me, env, cors));

      if (path === "/api/limit-request" && request.method === "POST") return await limitRequest(request, env, cors, ctx);

      return bad("not_found", 404);
    } catch (e) {
      return json({ error: "server_error", detail: String(e?.message || e).slice(0, 200) }, 500, cors);
    }
  },

  // ── cron: purge expired guest files & stale sessions ──────────────────────
  async scheduled(event, env, ctx) {
    const nowMs = Date.now();
    const { results: expired } = await env.DB.prepare(
      "SELECT id, drive_file_id FROM files WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 200"
    ).bind(nowMs).all();
    for (const f of expired || []) {
      if (f.drive_file_id) {
        try { await driveDelete(await getAccessToken(env), f.drive_file_id); } catch {}
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(f.id),
        env.DB.prepare("DELETE FROM files WHERE id = ?").bind(f.id),
      ]);
    }
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowMs).run();
    await env.DB.prepare("DELETE FROM rl_counters WHERE bucket < ?").bind(Math.floor(nowMs / 600000) - 2).run();
  },
};

// ── auth ─────────────────────────────────────────────────────────────────────
async function authed(request, env, cors, handler) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return json({ error: "unauthorized" }, 401, cors);
  const sid = await sha256hex(token);
  // sessions are self-contained (username/nick copied in at login) — Host's
  // own DB has no users table, user records live in Inpriv ID
  const row = await env.DB.prepare(
    "SELECT expires_at, user_id AS uid, username, nick FROM sessions WHERE id = ?"
  ).bind(sid).first();
  if (!row || row.expires_at < Date.now()) return json({ error: "unauthorized" }, 401, cors);
  return handler({ uid: row.uid, user: { id: row.uid, username: row.username || "", nick: row.nick || row.username || "user" } });
}
const pub = (u) => ({ id: u.id, username: u.username, nick: u.nick || u.username });

async function login(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const input = String(body.user || "").trim().toLowerCase();
  const password = String(body.password || "");
  const totp = String(body.totp || "").trim();
  if (!input || !password) return bad("Enter your username and password", 400);

  // rate limit by IP prefix only (raw IPs are never stored)
  const rkey = "hostlogin:" + (request.headers.get("CF-Connecting-IP") || "x").split(".").slice(0, 2).join(".");
  if (!(await rateLimit(env.DB, rkey, 10, 15 * 60 * 1000)))
    return bad("Too many attempts — try again in 15 minutes", 429);

  // resolve the account in Inpriv ID — accept bare username, full Inpriv
  // address, or an external recovery address (ID stores usernames WITHOUT
  // the @inpriv.xyz suffix, so "saloyek" must resolve the same as
  // "saloyek@inpriv.xyz")
  const local = input.split("@")[0];
  const idu = await env.ID_DB.prepare(
    "SELECT id, username, nick, pass_hash, pass_salt, pass_iters, totp_enabled FROM users WHERE username IN (?, ?) OR email IN (?, ?) OR recovery_email IN (?, ?) LIMIT 1"
  ).bind(local, input, local + "@inpriv.xyz", input, input, local + "@inpriv.xyz").first();

  // anti-enumeration: burn the same PBKDF2 work when the user doesn't exist
  let ok = false;
  if (idu) {
    const cand = await passHash(password, idu.pass_salt, idu.pass_iters);
    ok = constantTimeEq(cand, idu.pass_hash);
  } else {
    await passHash(password, b64(crypto.getRandomValues(new Uint8Array(16))), PASS_ITERS);
  }
  if (!idu || !ok) return bad("Invalid credentials", 401);

  // TOTP when enabled on the Inpriv ID account — the secret stays sealed in
  // ID's vault, so Host delegates verification to ID's service endpoint
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

  // host-local session (token hashed at rest; username/nick denormalised so
  // Host never needs to join against Inpriv ID's users table)
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const sid = await sha256hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, username, nick, created_at, expires_at) VALUES (?,?,?,?,?,?)"
  ).bind(sid, idu.id, idu.username, idu.nick || idu.username, Date.now(), Date.now() + SESSION_TTL).run();
  return json({ token, user: pub({ id: idu.id, username: idu.username, nick: idu.nick }) }, 200, cors);
}

// ── per-account limits (storage quota raised via request → saloyek approves;
//   max_file_bytes kept for future per-file raises, defaults apply otherwise) ──
async function limitsFor(env, uid) {
  const r = await env.DB.prepare("SELECT max_file_bytes, quota_bytes FROM account_limits WHERE user_id = ?").bind(uid).first();
  const maxFile = r?.max_file_bytes || MAX_FILE_BYTES;
  const quota = r?.quota_bytes || USER_QUOTA_BYTES;
  return {
    max_file_bytes: maxFile, max_file_mb: Math.round(maxFile / 1048576),
    quota_bytes: quota, quota_gb: +(quota / 1073741824).toFixed(2),
  };
}

// ── anonymous (guest) uploads — no account, 7-day expiry, IP-prefix quota ───
function guestKey(request) {
  // hashed, truncated IP prefix — enough for quota bucketing, not an identifier
  const ip = (request.headers.get("CF-Connecting-IP") || "x").split(".").slice(0, 2).join(".");
  return "guest:" + ip;
}

async function guestBegin(request, env, cors) {
  if (!(await rateLimit(env.DB, guestKey(request) + ":uploads", 30, 24 * 3600 * 1000)))
    return bad("Too many uploads from this network — try again tomorrow", 429);
  const body = await request.json().catch(() => ({}));
  const name = sanitizeName(String(body.name || ""));
  const size = Number(body.size || 0);
  if (!name) return bad("Invalid file name", 400);
  if (size <= 0) return bad("Empty files are not supported", 400);
  if (size > ANON_MAX_FILE_BYTES) return bad("Guest limit is 50 MB per file — sign in with Inpriv ID for 100 MB", 413);

  const key = guestKey(request);
  const { used } = await env.DB.prepare(
    "SELECT COALESCE(SUM(size),0) AS used FROM files WHERE user_id = ? AND created_at > ?"
  ).bind(key, Date.now() - 7 * 24 * 3600 * 1000).first();
  if (used + size > ANON_QUOTA_BYTES)
    return bad("Guest storage full (2 GB / 7 days) — sign in with Inpriv ID for permanent hosting", 413);

  const id = uuid();
  const slug = await newSlug(env);
  const manageToken = b64(crypto.getRandomValues(new Uint8Array(24)));
  const ext = (name.split(".").pop() || "").toLowerCase();
  const mime = MIME[ext] || String(body.mime || "application/octet-stream");
  await env.DB.prepare(
    "INSERT INTO files (id, user_id, name, slug, size, mime, visibility, scan_status, expires_at, manage_token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, key, name, slug, size, mime, "public", SCANNABLE.has(ext) ? "pending" : "skip", Date.now() + ANON_TTL_MS, await sha256hex(manageToken), Date.now()).run();
  return json({ upload_id: id, chunk_size: CHUNK_BYTES, slug, manage_token: manageToken, expires_in: "7d" }, 200, cors);
}

async function guestChunk(url, request, uploadId, env, cors) {
  const f = await env.DB.prepare("SELECT id, size, user_id, expires_at FROM files WHERE id = ?").bind(uploadId).first();
  if (!f || !f.user_id.startsWith("guest:")) return bad("Upload not found", 404);
  if (f.expires_at && f.expires_at < Date.now()) return bad("Upload expired", 410);
  const seq = Number(url.searchParams.get("seq"));
  if (!Number.isInteger(seq) || seq < 0 || seq > 999) return bad("Bad chunk index", 400);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length === 0) return bad("Empty chunk", 400);
  if (buf.length > CHUNK_MAX) return bad("Chunk too large (max 2 MB)", 413);
  const total = Math.max(1, Math.ceil(f.size / CHUNK_BYTES));
  if (seq >= total) return bad("Chunk index out of range", 400);
  await env.DB.prepare(
    "INSERT INTO chunks (file_id, seq, data) VALUES (?,?,?) ON CONFLICT(file_id, seq) DO UPDATE SET data = excluded.data"
  ).bind(uploadId, seq, buf).run();
  return json({ ok: true, received: buf.length }, 200, cors);
}

// read chunks in pages — a single SELECT of a whole 100 MB file would blow
// past D1's per-query response cap; 8 × 1.5 MB pages stay well under it
async function fetchChunks(env, uploadId, pageSize = 8) {
  const rows = [];
  for (let off = 0; ; off += pageSize) {
    const { results } = await env.DB.prepare(
      "SELECT seq, data FROM chunks WHERE file_id = ? ORDER BY seq LIMIT ? OFFSET ?"
    ).bind(uploadId, pageSize, off).all();
    if (!results || !results.length) break;
    rows.push(...results);
    if (results.length < pageSize) break;
  }
  return rows;
}

async function guestComplete(uploadId, request, env, cors) {
  const f = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(uploadId).first();
  if (!f || !f.user_id.startsWith("guest:")) return bad("Upload not found", 404);
  if (f.drive_file_id) return bad("Upload already completed", 409);
  // management token proves ownership of a guest upload
  const body = await request.json().catch(() => ({}));
  const mt = String(body.manage_token || "");
  if (!mt || (await sha256hex(mt)) !== f.manage_token) return bad("unauthorized", 401);

  const rows = await fetchChunks(env, uploadId);
  if (!rows || !rows.length) return bad("No chunks received", 400);
  const received = rows.reduce((s, c) => s + (c.data.byteLength ?? c.data.length), 0);
  let continuous = true;
  for (let i = 0; i < rows.length; i++) if (rows[i].seq !== i) { continuous = false; break; }
  if (!continuous || received !== f.size)
    return bad(`Upload incomplete — declared ${f.size} B, received ${received} B`, 400);

  const ext = (f.name.split(".").pop() || "").toLowerCase();
  let scan = { status: "skip", findings: [], summary: "Binary format — source scan not applicable" };
  if (SCANNABLE.has(ext)) {
    let text = "", taken = 0;
    for (const c of rows) {
      if (taken >= TEXT_SCAN_LIMIT) break;
      const cd_ = c.data instanceof ArrayBuffer ? new Uint8Array(c.data)
        : Array.isArray(c.data) ? new Uint8Array(c.data)
        : typeof c.data === "string" ? Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0))
        : c.data;
      text += new TextDecoder("utf-8", { fatal: false }).decode(cd_);
      taken += c.data.length;
    }
    scan = scanText(text.slice(0, TEXT_SCAN_LIMIT * 2), f.name);
  }
  if (scan.status === "blocked") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(uploadId),
      env.DB.prepare(
        "UPDATE files SET scan_status = 'blocked', scan_summary = ?, scan_findings = ? WHERE id = ?"
      ).bind(scan.summary, JSON.stringify(scan.findings.slice(0, 30)), uploadId),
    ]);
    return json({ ok: false, blocked: true, scan }, 200, cors);
  }

  const token = await getAccessToken(env);
  const toU8 = (d) => d instanceof ArrayBuffer ? new Uint8Array(d)
      : Array.isArray(d) ? new Uint8Array(d)
      : typeof d === "string" ? Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0))
      : d;
  const driveId = await driveUpload(token, env, f, rows.map((c) => toU8(c.data)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(uploadId),
    env.DB.prepare(
      "UPDATE files SET drive_file_id = ?, scan_status = 'published', scan_summary = ? WHERE id = ?"
    ).bind(driveId, scan.summary, uploadId),
  ]);
  return json({ ok: true, blocked: false, scan, slug: f.slug, url: "/f/" + f.slug, manage_token: mt }, 200, cors);
}

async function guestAbort(uploadId, env, cors) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(uploadId),
    env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id LIKE 'guest:%' AND drive_file_id IS NULL").bind(uploadId),
  ]);
  return json({ ok: true }, 200, cors);
}

// delete a published guest file with its one-time manage token
async function guestDelete(request, env, cors) {
  if (!(await rateLimit(env.DB, "gdel:" + guestKey(request).slice(6), 20, 3600 * 1000)))
    return bad("Too many attempts — slow down", 429);
  const body = await request.json().catch(() => ({}));
  const mt = String(body.manage_token || "");
  if (!mt) return bad("Missing manage key", 400);
  const f = await env.DB.prepare(
    "SELECT id, drive_file_id FROM files WHERE manage_token = ? AND user_id LIKE 'guest:%'"
  ).bind(await sha256hex(mt)).first();
  if (!f) return bad("No guest file matches this key", 404);
  if (f.drive_file_id) {
    try { await driveDelete(await getAccessToken(env), f.drive_file_id); } catch {}
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(f.id),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(f.id),
  ]);
  return json({ ok: true }, 200, cors);
}

// ── custom slug: host.inpriv.xyz/s/<name> (signed-in owners only) ────────────
async function setCustomSlug(fid, request, me, env, cors) {
  const body = await request.json().catch(() => ({}));
  const custom = String(body.custom || "").trim().toLowerCase();
  const f = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND user_id = ? AND scan_status = 'published'").bind(fid, me.uid).first();
  if (!f) return bad("File not found or not published", 404);

  if (custom === "") {
    await env.DB.prepare("UPDATE files SET custom_slug = NULL WHERE id = ?").bind(fid).run();
    return json({ ok: true, custom: null }, 200, cors);
  }
  if (!CUSTOM_RE.test(custom)) return bad("Use 4-40 chars: lowercase letters, digits, hyphens", 400);
  if (CUSTOM_RESERVED.has(custom)) return bad("This name is reserved", 400);

  const existing = await env.DB.prepare("SELECT user_id FROM files WHERE custom_slug = ?").bind(custom).first();
  if (existing) return bad("This link is already taken — try another", 409);
  // one custom link per file
  await env.DB.prepare("UPDATE files SET custom_slug = ? WHERE id = ?").bind(custom, fid).run();
  return json({ ok: true, custom, url: "/s/" + custom }, 200, cors);
}

// ── limit-increase request → encrypted message into saloyek@inpriv.xyz ───────
// The request asks for more STORAGE (GB), not a bigger per-file cap.
async function adminPubKey(request, env, cors) {
  const u = await env.MAIL_DB.prepare("SELECT public_key FROM users WHERE id = ?").bind(ADMIN_MAIL_USER_ID).first();
  if (!u?.public_key) return bad("admin mailbox unavailable", 503);
  return json({ pubkey: u.public_key }, 200, {
    ...cors,
    "Cache-Control": "public, max-age=3600",
  });
}

async function limitRequest(request, env, cors, ctx) {
  // rate limit by IP prefix (hashed key, no raw IP stored)
  if (!(await rateLimit(env.DB, "limitreq:" + guestKey(request).slice(6), 3, 24 * 3600 * 1000)))
    return bad("You already sent requests today — wait for a reply at your contact address", 429);

  const body = await request.json().catch(() => ({}));
  const contact = String(body.contact || "").trim().slice(0, 120);
  const currentGb = Number(body.current_gb || 0);
  const requestedGb = Number(body.requested_gb || 0);
  const envelope = body.envelope; // { encrypted_aes_key, iv, ciphertext, auth_tag } — reason text, RSA-OAEP to admin pubkey
  if (!contact || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) return bad("Enter a valid contact e-mail", 400);
  if (!Number.isInteger(requestedGb) || requestedGb < 2 || requestedGb > 50) return bad("Request between 2 GB and 50 GB of storage", 400);
  if (!envelope || !envelope.ciphertext || !envelope.encrypted_aes_key) return bad("Missing encrypted reason", 400);

  const claimed = "uid:" + (typeof body.user_id === "string" ? body.user_id.slice(0, 40) : "guest");
  const r = await env.DB.prepare(
    "INSERT INTO limit_requests (user_id, contact, current_mb, requested_mb, reason_enc, created_at) VALUES (?,?,?,?,?,?)"
  ).bind(claimed, contact, Math.min(100000, Math.round(currentGb * 1024)), requestedGb * 1024, JSON.stringify(envelope).slice(0, 4000), Date.now()).run();
  const rid = r?.meta?.last_row_id;

  // deliver as an Inpriv Mail message (zero-knowledge — reason stays encrypted)
  ctx.waitUntil((async () => {
    try {
      const admin = await env.MAIL_DB.prepare("SELECT id FROM users WHERE id = ?").bind(ADMIN_MAIL_USER_ID).first();
      if (!admin) return;
      // envelope fields are already encrypted client-side to the admin pubkey
      // note: reason_enc is already encrypted to the admin pubkey client-side;
      // the notification above contains only routing metadata (no reason text).
      await env.MAIL_DB.prepare(
        "INSERT INTO messages (owner_id, direction, peer_address, subject, encrypted_aes_key, iv, ciphertext, auth_tag, is_read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)"
      ).bind(ADMIN_MAIL_USER_ID, "inbound", contact, "Host storage limit request #" + rid, envelope.encrypted_aes_key, envelope.iv, envelope.ciphertext, envelope.auth_tag, Date.now()).run();
    } catch {}
  })());

  return json({ ok: true, request_id: rid, message: "Request sent — reply arrives at " + contact }, 200, cors);
}
async function listFiles(me, env, cors) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, slug, custom_slug, size, mime, visibility, hits, scan_status, scan_summary, expires_at, created_at FROM files WHERE user_id = ? AND drive_file_id IS NOT NULL ORDER BY created_at DESC LIMIT 500"
  ).bind(me.uid).all();
  const used = (results || []).reduce((s, f) => s + (f.size || 0), 0);
  return json({
    files: (results || []).map((f) => ({ ...f, url: f.custom_slug ? "/s/" + f.custom_slug : "/f/" + f.slug })),
    used, quota: USER_QUOTA_BYTES, limits: await limitsFor(env, me.uid),
  }, 200, cors);
}

async function beginUpload(request, me, env, cors) {
  const body = await request.json().catch(() => ({}));
  const name = sanitizeName(String(body.name || ""));
  const size = Number(body.size || 0);
  const limits = await limitsFor(env, me.uid);
  if (!name) return bad("Invalid file name", 400);
  if (size <= 0) return bad("Empty files are not supported", 400);
  if (size > limits.max_file_bytes) return bad(`File exceeds your current ${limits.max_file_mb} MB limit`, 413);

  const { n, used } = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS used FROM files WHERE user_id = ?"
  ).bind(me.uid).first();
  if (n >= MAX_FILES) return bad("File limit reached (5000)", 400);
  if (used + size > limits.quota_bytes)
    return bad("Storage limit reached — request a higher limit or delete some files", 413);

  const id = uuid();
  const slug = await newSlug(env);
  const ext = (name.split(".").pop() || "").toLowerCase();
  const mime = MIME[ext] || String(body.mime || "application/octet-stream");
  await env.DB.prepare(
    "INSERT INTO files (id, user_id, name, slug, size, mime, visibility, scan_status, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(id, me.uid, name, slug, size, mime, "private", SCANNABLE.has(ext) ? "pending" : "skip", Date.now()).run();
  return json({ upload_id: id, chunk_size: CHUNK_BYTES, slug }, 200, cors);
}

async function putChunk(url, request, uploadId, me, env, cors) {
  const f = await env.DB.prepare("SELECT id, size FROM files WHERE id = ? AND user_id = ?").bind(uploadId, me.uid).first();
  if (!f) return bad("Upload not found", 404);
  const seq = Number(url.searchParams.get("seq"));
  if (!Number.isInteger(seq) || seq < 0 || seq > 999) return bad("Bad chunk index", 400);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length === 0) return bad("Empty chunk", 400);
  if (buf.length > CHUNK_MAX) return bad("Chunk too large (max 2 MB)", 413);
  const total = Math.max(1, Math.ceil(f.size / CHUNK_BYTES));
  if (seq >= total) return bad("Chunk index out of range", 400);
  await env.DB.prepare(
    "INSERT INTO chunks (file_id, seq, data) VALUES (?,?,?) ON CONFLICT(file_id, seq) DO UPDATE SET data = excluded.data"
  ).bind(uploadId, seq, buf).run();
  return json({ ok: true, received: buf.length }, 200, cors);
}

async function completeUpload(uploadId, me, env, cors) {
  const f = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND user_id = ?").bind(uploadId, me.uid).first();
  if (!f) return bad("Upload not found", 404);
  if (f.drive_file_id) return bad("Upload already completed", 409);

  const rows = await fetchChunks(env, uploadId);
  if (!rows || !rows.length) return bad("No chunks received", 400);

  // integrity: seq continuity + declared size
  const expectedSize = f.size;
  const received = rows.reduce((s, c) => s + (c.data.byteLength ?? c.data.length), 0);
  let continuous = true;
  for (let i = 0; i < rows.length; i++) if (rows[i].seq !== i) { continuous = false; break; }
  if (!continuous || received !== expectedSize)
    return bad(`Upload incomplete — declared ${expectedSize} B, received ${received} B`, 400);

  const ext = (f.name.split(".").pop() || "").toLowerCase();

  // ── privacy shield: scan BEFORE anything is published ──
  let scan = { status: "skip", findings: [], summary: "Binary format — source scan not applicable" };
  if (SCANNABLE.has(ext)) {
    let text = "";
    let taken = 0;
    for (const c of rows) {
      if (taken >= TEXT_SCAN_LIMIT) break;
      const cd_ = c.data instanceof ArrayBuffer ? new Uint8Array(c.data)
        : Array.isArray(c.data) ? new Uint8Array(c.data)
        : typeof c.data === "string" ? Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0))
        : c.data;
      text += new TextDecoder("utf-8", { fatal: false }).decode(cd_);
      taken += c.data.length;
    }
    scan = scanText(text.slice(0, TEXT_SCAN_LIMIT * 2), f.name);
  }

  if (scan.status === "blocked") {
    // quarantine: drop chunks, keep the record + findings for the owner
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(uploadId),
      env.DB.prepare(
        "UPDATE files SET scan_status = 'blocked', scan_summary = ?, scan_findings = ? WHERE id = ?"
      ).bind(scan.summary, JSON.stringify(scan.findings.slice(0, 30)), uploadId),
    ]);
    return json({ ok: false, blocked: true, scan }, 200, cors);
  }

  // ── store on Google Drive (multipart upload, file named by UUID) ──
  const token = await getAccessToken(env);
  const toU8 = (d) => d instanceof ArrayBuffer ? new Uint8Array(d)
      : Array.isArray(d) ? new Uint8Array(d)
      : typeof d === "string" ? Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0))
      : d;
  const driveId = await driveUpload(token, env, f, rows.map((c) => toU8(c.data)));

  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(uploadId),
    env.DB.prepare(
      "UPDATE files SET drive_file_id = ?, scan_status = 'published', scan_summary = ? WHERE id = ?"
    ).bind(driveId, scan.summary, uploadId),
  ]);
  return json({ ok: true, blocked: false, scan, slug: f.slug, url: "/f/" + f.slug }, 200, cors);
}

async function abortUpload(uploadId, me, env, cors) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(uploadId),
    env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ? AND drive_file_id IS NULL").bind(uploadId, me.uid),
  ]);
  return json({ ok: true }, 200, cors);
}

async function setVisibility(fid, request, me, env, cors) {
  const body = await request.json().catch(() => ({}));
  const vis = body.visibility === "public" ? "public" : "private";
  const r = await env.DB.prepare(
    "UPDATE files SET visibility = ? WHERE id = ? AND user_id = ? AND scan_status = 'published' RETURNING visibility"
  ).bind(vis, fid, me.uid).first();
  if (!r) return bad("File not found or not published", 404);
  return json({ ok: true, visibility: r.visibility }, 200, cors);
}

async function deleteFile(fid, me, env, cors) {
  const f = await env.DB.prepare("SELECT id, drive_file_id FROM files WHERE id = ? AND user_id = ?").bind(fid, me.uid).first();
  if (!f) return bad("File not found", 404);
  if (f.drive_file_id) {
    try { await driveDelete(await getAccessToken(env), f.drive_file_id); } catch { /* D1 record removed below regardless */ }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(fid),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fid),
  ]);
  return json({ ok: true }, 200, cors);
}

// ── serving ──────────────────────────────────────────────────────────────────
async function servePublic(request, env, ctx, path) {
  const seg = path.split("/")[2] || "";
  const isCustom = path.startsWith("/s/");
  const slug = seg.toLowerCase();
  const okShape = isCustom ? /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/.test(slug) : /^[a-z0-9]{8,14}$/.test(slug);
  if (!okShape) return notFoundPage();
  const f = await env.DB.prepare(
    "SELECT id, name, size, mime, visibility, scan_status, drive_file_id, expires_at FROM files WHERE " +
    (isCustom ? "custom_slug = ?" : "slug = ?")
  ).bind(slug).first();
  if (!f || !f.drive_file_id || f.scan_status !== "published" || f.visibility !== "public") return notFoundPage();
  if (f.expires_at && f.expires_at < Date.now()) return gonePage(); // guest file past its 7-day TTL

  const upstream = await driveDownload(await getAccessToken(env), f.drive_file_id);
  if (!upstream.ok || !upstream.body) return notFoundPage();

  const headers = serveHeaders(f);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  ctx.waitUntil(env.DB.prepare("UPDATE files SET hits = hits + 1 WHERE id = ?").bind(f.id).run().catch(() => {}));
  return new Response(upstream.body, { status: 200, headers });
}

function gonePage() {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Link expired — Inpriv Host</title><style>body{font-family:system-ui,sans-serif;background:#13140e;color:#e3e2d3;` +
    `display:grid;place-items:center;min-height:100vh;margin:0}.box{max-width:420px;text-align:center;padding:44px 32px;` +
    `background:rgba(26,28,23,.85);border:1px solid rgba(141,142,131,.25);border-radius:28px}h1{font-size:1.25rem;margin:0 0 10px}` +
    `p{color:#c7c6b8;font-size:.92rem}a{color:#abd37a}</style></head><body><div class="box"><h1>This link has expired</h1>` +
    `<p>Guest uploads stay live for 7 days. Sign in with an Inpriv ID to host files permanently.</p>` +
    `<p style="margin-top:18px;font-size:.85rem"><a href="https://host.inpriv.xyz">&larr; back to Inpriv Host</a></p></div></body></html>`,
    { status: 410, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  );
}

// owner preview via API (Bearer token, streamed from Drive, never public)
async function servePrivate(fid, me, env, cors) {
  const f = await env.DB.prepare(
    "SELECT id, name, size, mime, scan_status, drive_file_id FROM files WHERE id = ? AND user_id = ?"
  ).bind(fid, me.uid).first();
  if (!f || !f.drive_file_id || f.scan_status !== "published") return bad("File not found", 404);
  const upstream = await driveDownload(await getAccessToken(env), f.drive_file_id);
  if (!upstream.ok || !upstream.body) return bad("Storage error", 502);
  const headers = serveHeaders(f);
  headers["cache-control"] = "private, no-store";
  return new Response(upstream.body, { status: 200, headers });
}

function serveHeaders(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const download = FORCE_DOWNLOAD.has(ext);
  const isText = SCANNABLE.has(ext);
  const h = {
    "content-type": f.mime || "application/octet-stream",
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${asciiName(f.name)}"`,
    "cache-control": `public, max-age=${SERVE_CACHE_S}, immutable`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "cross-origin-resource-policy": "cross-site",
    "timing-allow-origin": "none",
    "content-security-policy": isText
      ? "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; media-src data: blob:; font-src data:; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      : "default-src 'none'; img-src 'self' data:; media-src 'self' data: blob:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  if (f.size) h["content-length"] = String(f.size);
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVACY SHIELD — static source scanner
// Blocks: IP loggers & grabber links · WebRTC IP probes · pixel/beacon
// trackers · unapproved external scripts · covert redirects · obfuscation.
// ═══════════════════════════════════════════════════════════════════════════
function scanText(text, fname) {
  const findings = [];
  let blocked = false;
  const add = (severity, code, title, detail, evidence) => {
    findings.push({ severity, code, title, detail, evidence: String(evidence || "").slice(0, 160) });
    if (severity === "block") blocked = true;
  };

  // 1 · IP logger / grabber / IP-lookup domains (hard block)
  const LOGGER_DOMAINS = [
    "iplogger.org", "iplogger.com", "iplogger.ru", "iplogger.io", "2no.co", "ip-tracker.org",
    "iptracker.link", "grabify.link", "grabify.icu", "grabify.track", "boost.ink", "gamerbox.hu",
    "yip.su", "yips.su", "cyber-hub.pw", "blasze.com", "blasze.tk", "blackshield.io",
    "ipgrab.org", "grab-ip.com", "ipgraber.com", "wcodez.com", "psyco.site", "iplog.co",
    "locations.gq", "streakin.site", "leancoding.co", "stopify.co", "shortit.pw",
    "gitulation.site", "weirdify.site", "invisify.site", "revealmyip.com", "verifyyouarehuman.com",
    "whatstheirip.com", "iwanttoproxythisforyou.com", "trackip.net", "ipgrabber.com",
    "api.ipify.org", "ipify.org", "icanhazip.com", "checkip.amazonaws.com", "ipwho.is",
    "ipapi.co", "ipinfo.io", "ipgeolocation.io", "ipdata.co", "ipwhois.io", "freegeoip.app",
    "reallyfreegeoip.org", "extreme-ip-lookup.com", "whatismyipaddress.com", "ipify.me",
    "ipapi.click", "ip-checker.net", "myexternalip.com", "ident.me", "icanhazip.com",
    "seeip.org", "ipify.xyz", "ipv4.icanhazip.com", "smart-ip.net", "ip.js.org",
  ];
  const lower = text.toLowerCase();
  const found = [...new Set(LOGGER_DOMAINS.filter((d) => lower.includes(d)))];
  if (found.length) {
    add("block", "ip_logger", "IP logger / IP-grabbing service detected",
      "This file contacts a service whose purpose is collecting visitor IP addresses. The file was blocked from publishing.",
      found.slice(0, 5).join(" · "));
  }

  // 2 · WebRTC leak probes (hard block)
  const WEBRTC = [
    [/new\s+RTCPeerConnection/, "RTCPeerConnection instantiation"],
    [/webkitRTCPeerConnection|mozRTCPeerConnection/, "legacy WebRTC API"],
    [/createDataChannel\s*\(/, "WebRTC data channel (classic local-IP probe)"],
    [/\bonicecandidate\b/, "ICE candidate harvesting"],
    [/\bcreateOffer\s*\(/, "SDP offer creation"],
    [/stun:[a-z0-9.+-]+/i, "STUN server reference"],
    [/\biceServers?\s*:/i, "ICE/STUN/TURN configuration"],
  ];
  const rtcHits = [...new Set(WEBRTC.filter(([re]) => re.test(text)).map(([, why]) => why))];
  if (rtcHits.length) {
    add("block", "webrtc_leak", "WebRTC IP-leak probe detected",
      "The page opens WebRTC connections that can expose the visitor's real or local IP address.",
      rtcHits.slice(0, 4).join(" · "));
  }

  // 3 · pixel beacons & remote images (hard block)
  const imgSrcs = [...text.matchAll(/<img[^>]+src\s*=\s*["']?([^"'\s>]+)["']?/gi)].map((m) => m[1]);
  for (const src of imgSrcs) {
    if (/^https?:\/\//i.test(src) || /^\/\//.test(src)) {
      add("block", "img_beacon", "External image beacon",
        "Images loaded from third-party servers log every visitor's IP, time and referrer.",
        src);
      break;
    }
  }
  if (/new\s+Image\s*\(\)/.test(text) && /\.src\s*=\s*["'][^"']*https?:\/\//i.test(text)) {
    const m = text.match(/\.src\s*=\s*["']([^"']+)["']/i);
    add("block", "js_beacon", "JavaScript image beacon",
      "Script builds an Image pointing at a remote URL — a classic covert IP logger.", m?.[1]);
  }

  // 4 · unapproved external scripts (hard block, known CDNs allowed)
  const SCRIPT_OK = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|code\.jquery\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh|cdn\.skypack\.dev)\//;
  for (const m of text.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    const s = m[1];
    if (!SCRIPT_OK.test(s)) {
      add("block", "ext_script", "External script not allowed",
        "Scripts from unapproved origins can exfiltrate visitor data. Allowed CDNs: jsdelivr, cdnjs, unpkg, jQuery, Google Fonts, esm.sh, Skypack.",
        s);
    }
  }

  // 5 · outbound network calls (hard block)
  for (const m of text.matchAll(/\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    if (/^https?:\/\//i.test(m[1])) {
      add("block", "fetch_beacon", "Outbound fetch request",
        "The page calls a remote server directly — this can transmit visitor IPs and page content.", m[1]);
      break;
    }
  }
  if (/new\s+XMLHttpRequest/.test(text)) {
    add("block", "xhr_beacon", "XMLHttpRequest detected",
      "XHR can silently send visitor data to remote endpoints.");
  }
  if (/\bWebSocket\s*\(/.test(text)) {
    add("block", "websocket", "WebSocket connection",
      "Live sockets can fingerprint and track visitors in real time.");
  }

  // 6 · embedding & redirects (hard block)
  if (/<(iframe|embed|object)\b[^>]*(src|data)\s*=\s*["']?https?:\/\//i.test(text)) {
    const m = text.match(/<(iframe|embed|object)\b[^>]*(?:src|data)\s*=\s*["']?([^"'\s>]+)/i);
    add("block", "embed", "Third-party embed (iframe/embed/object)",
      "Embedded frames run third-party code that can log visitor IPs.", m?.[2]);
  }
  const mr = text.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?[^"'>]*url=https?:\/\/([^"'>\s]+)/i);
  if (mr) {
    add("block", "meta_refresh", "Meta-refresh redirect to external URL",
      "Redirect chains are used by IP grabbers to bounce visitors through loggers.", mr[1]);
  }
  if (/\b(?:window\.)?location(?:\.href)?\s*=\s*["']https?:\/\//i.test(text) ||
      /location\.replace\s*\(\s*["']https?:\/\//i.test(text)) {
    const m = text.match(/["'](https?:\/\/[^"']{6,120})["']/i);
    add("block", "js_redirect", "JavaScript redirect to external URL",
      "Forced navigation can bounce visitors through tracking domains.", m?.[1]);
  }
  if (/<link[^>]+rel\s*=\s*["']?preload["']?[^>]+as\s*=\s*["']?(fetch|script)["']?[^>]+https?:\/\//i.test(text)) {
    add("block", "preload_beacon", "Preload of remote resource",
      "Preloaded remote resources leak visitor IPs before the page even renders.");
  }

  // 7 · CSS exfiltration channels (hard block)
  if (/@import\s+(?:url\s*\()?\s*["']?https?:\/\//i.test(text)) {
    const m = text.match(/@import\s+(?:url\s*\()?\s*["']?([^"')\s]+)/i);
    add("block", "css_import", "CSS @import from external origin",
      "External CSS imports leak the visitor's IP and reading time.", m?.[1]);
  }
  for (const m of text.matchAll(/url\s*\(\s*["']?(https?:\/\/[^)"'\s]+)/gi)) {
    add("block", "css_url", "CSS references external resource",
      "Remote images/fonts inside CSS phone home on every page view.", m[1]);
    break;
  }

  // 8 · sensitive APIs & obfuscation (hard block)
  if (/navigator\.(clipboard|geolocation|mediaDevices|sendBeacon)/.test(text)) {
    add("block", "device_api", "Sensitive browser API access",
      "Clipboard, geolocation, camera/microphone or sendBeacon usage detected.");
  }
  if (/\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(\s*atob|\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i.test(text)) {
    add("block", "obfuscation", "Obfuscated or dynamic code execution",
      "eval / new Function / document.write(atob(…)) / long hex-escape strings — typical of hidden loggers.");
  }

  // 9 · informational notes (no block)
  if (/(?:UA-\d{4,}-\d{1,3}|G-[A-Z0-9]{8,})/.test(text))
    add("info", "ga_id", "Analytics ID pattern", "Analytics property ID present in text (informational).");
  if (/connect\.facebook\.net|\bfbq\s*\(/i.test(lower))
    add("info", "fb_pixel", "Meta pixel pattern", "Facebook pixel signature present in text (informational).");

  const blocks = findings.filter((x) => x.severity === "block").length;
  const infos = findings.filter((x) => x.severity === "info").length;
  const summary = blocked
    ? `${blocks} blocking issue${blocks > 1 ? "s" : ""} — file quarantined, nothing was published`
    : `Clean — no loggers, trackers or leak probes found${infos ? ` (${infos} informational note${infos > 1 ? "s" : ""})` : ""}`;
  return { status: blocked ? "blocked" : "pass", findings, summary };
}

// ── Google Drive (user OAuth refresh token preferred; service account fallback) ──
async function getAccessToken(env) {
  const nowSec0 = Math.floor(Date.now() / 1000);

  // Preferred: user OAuth — files are owned by the user and use their quota
  if (env.DRIVE_OAUTH) {
    let oa;
    try { oa = JSON.parse(env.DRIVE_OAUTH); } catch { throw new Error("drive_bad_oauth_secret"); }
    const cached = await env.KV.get("drive_token");
    if (cached) {
      try {
        const t = JSON.parse(cached);
        if (t.exp - 300 > nowSec0) return t.token;
      } catch {}
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oa.client_id,
        client_secret: oa.client_secret,
        refresh_token: oa.refresh_token,
      }),
    });
    if (!res.ok) throw new Error("drive_oauth_refresh_failed: " + res.status + " " + (await res.text()).slice(0, 120));
    const d = await res.json();
    await env.KV.put("drive_token", JSON.stringify({ token: d.access_token, exp: nowSec0 + (d.expires_in || 3600) }), { expirationTtl: 3300 });
    return d.access_token;
  }

  // Fallback: service account JWT (works only on Workspace shared drives)
  if (!env.DRIVE_SERVICE_ACCOUNT) throw new Error("drive_not_configured");
  let sa;
  try { sa = JSON.parse(env.DRIVE_SERVICE_ACCOUNT); } catch { throw new Error("drive_bad_secret"); }
  const nowSec = Math.floor(Date.now() / 1000);

  const cached = await env.KV.get("drive_token");
  if (cached) {
    try {
      const t = JSON.parse(cached);
      if (t.exp - 300 > nowSec) return t.token;
    } catch {}
  }

  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec, exp: nowSec + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemDecode(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const data = te(header + "." + claims);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data));
  const jwt = header + "." + claims + "." + b64url(sig);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error("drive_token_failed: " + res.status);
  const d = await res.json();
  await env.KV.put("drive_token", JSON.stringify({ token: d.access_token, exp: nowSec + (d.expires_in || 3600) }), { expirationTtl: 3300 });
  return d.access_token;
}

async function driveUpload(token, env, f, chunkBuffers) {
  const boundary = "inpriv" + crypto.randomUUID().replace(/-/g, "");
  const meta = JSON.stringify({
    name: f.id, // UUID only — original filename never leaves D1
    parents: env.DRIVE_FOLDER_ID ? [env.DRIVE_FOLDER_ID] : undefined,
    mimeType: f.mime || "application/octet-stream",
  });
  const head =
    te(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
       `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = te(`\r\n--${boundary}--`);
  const body = new Blob([head, ...chunkBuffers, tail]);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id",
    { method: "POST", headers: { authorization: "Bearer " + token, "content-type": `multipart/related; boundary=${boundary}` }, body }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error("drive_upload_failed: " + res.status + " " + t.slice(0, 200));
  }
  const d = await res.json();
  return d.id;
}

async function driveDownload(token, fileId) {
  return fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: "Bearer " + token },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
}

async function driveDelete(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: "DELETE", headers: { authorization: "Bearer " + token },
  });
  if (!res.ok && res.status !== 204 && res.status !== 404) throw new Error("drive_delete_failed");
}

// ── misc ─────────────────────────────────────────────────────────────────────
const te = (s) => new TextEncoder().encode(s);
const b64urlStr = (s) => b64(te(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64url = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function pemDecode(pem) {
  const body = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}
function sanitizeName(n) {
  let s = String(n || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  if (s === "." || s === ".." || !s) s = "file";
  return s.slice(0, 180);
}
function asciiName(n) { return String(n || "file").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_"); }
async function newSlug(env) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  for (let attempt = 0; attempt < 5; attempt++) {
    let s = "";
    for (const b of crypto.getRandomValues(new Uint8Array(10))) s += alphabet[b % alphabet.length];
    if (!(await env.DB.prepare("SELECT 1 FROM files WHERE slug = ?").bind(s).first())) return s;
  }
  return "f" + Date.now().toString(36);
}
function harden(res) {
  if (!res) return res;
  const r = new Response(res.body, res);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "no-referrer");
  return r;
}
function notFoundPage() {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>File not found — Inpriv Host</title><style>body{font-family:system-ui,sans-serif;background:#13140e;color:#e3e2d3;` +
    `display:grid;place-items:center;min-height:100vh;margin:0}.box{max-width:420px;text-align:center;padding:44px 32px;` +
    `background:rgba(26,28,23,.85);border:1px solid rgba(141,146,131,.25);border-radius:28px}h1{font-size:1.25rem;margin:0 0 10px}` +
    `p{color:#c7c6b8;font-size:.92rem}a{color:#abd37a}</style></head><body><div class="box"><h1>File not found</h1>` +
    `<p>This file does not exist, is private, or was blocked by the privacy shield.</p>` +
    `<p style="margin-top:18px;font-size:.85rem"><a href="https://host.inpriv.xyz">&larr; back to Inpriv Host</a></p></div></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  );
}
