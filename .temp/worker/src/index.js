// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Temp — disposable email addresses on inpriv.xyz
//
// Inbound:  Resend Receiving (MX → Resend) → webhook `email.received`
//           → POST /api/inbound (svix signature verified) → D1.
//           Metadata comes from the webhook; the body is fetched from the
//           Received emails API when a read-capable key is configured.
// Outbound: Resend send API (restricted send key is enough).
// Mailboxes are created on demand, live for 24 h, swept by hourly cron.
// An address is claimed for good when it's created (common/addresses.js):
// once the inbox expires its messages are deleted, but the address is never
// handed to anyone else.
// ─────────────────────────────────────────────────────────────────────────────

import { notFound } from "../../../common/errors.js";
import { canonicalRedirect } from "../../../common/canonical.js";
import { purgeAccessLog } from "../../../common/access-log.js";
import { maintenancePage as sharedMaintenancePage } from "../../../common/gate.js";
import { clientKey, originAllowed, isUnsafeMethod, pageResponse, apiHeaders, withHeaders } from "../../../common/security.js";
import { isReservedLocal, tempLocal, tryClaim, claimMany, ensureClaims, backfillIdClaims } from "../../../common/addresses.js";
import { sanitizeEmailHtml } from "../../../common/email-html.js";

const MAILBOX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h, then cron sweeps it away
const MAX_TEXT_CHARS = 100_000;
const MAX_HTML_CHARS = 300_000;
const MAX_ATT_PER_FILE = 512 * 1024;        // larger attachments are listed, not stored
const MAX_ATT_TOTAL = 2 * 1024 * 1024;
const SEND_HOURLY_LIMIT = 10;
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // hard cap for stored messages
const SVIX_TOLERANCE_S = 5 * 60;            // reject webhook timestamps older/newer than 5 min

// Inboxes one network can create: per hour, and custom names per hour.
const CREATE_HOURLY_LIMIT = 20;
const CUSTOM_HOURLY_LIMIT = 5;

export default {
  async fetch(request, env, ctx) {
    return canonicalRedirect(request) || handleFetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  },
};

// Exported for unit tests (svix verification against official test vectors).
export { verifySvix };

// ── maintenance / kill-switch (admin.inpriv.xyz) ─────────────────────────────

let gateCache = { data: null, until: 0 };

async function maintenanceGate(env) {
  const now = Date.now();
  if (gateCache.data && gateCache.until > now) return gateCache.data;
  try {
    const res = await fetch("https://admin.inpriv.xyz/public/state", {
      headers: { "User-Agent": "inpriv-temp-gate" },
      cf: { cacheTtl: 2, cacheEverything: true },
    });
    const st = await res.json();
    const svc = (st.services && st.services.temp) || { locked: false, message: "" };
    const locked = !!(st.global && st.global.locked) || !!svc.locked;
    const message = (st.global && st.global.locked && st.global.message) || svc.message || "";
    const info = st.info && st.info.active ? st.info.message : null;
    gateCache = { data: { locked, message, info }, until: now + 3_000 };
    return gateCache.data;
  } catch {
    // admin unreachable → fail open (the tool stays up), retry soon
    gateCache = { data: { locked: false, message: "", info: null }, until: now + 2_000 };
    return gateCache.data;
  }
}

function maintenancePage(gate) {
  return sharedMaintenancePage("Inpriv Temp", gate.message);
}

// ── HTTP API ─────────────────────────────────────────────────────────────────

async function handleFetch(request, env) {
  const url = new URL(request.url);

  // kill-switch (admin.inpriv.xyz): global lock or service "temp" lock.
  // /api/health and the inbound webhook always pass (monitoring + no lost mail).
  const isApi = url.pathname.startsWith("/api/");
  const exempt = url.pathname === "/api/health" || url.pathname === "/api/inbound" || url.pathname === "/api/maintenance";
  if (isApi && !exempt) {
    const gate = await maintenanceGate(env);
    if (gate.locked) return json({ error: "service_locked", message: gate.message }, 503);
  } else if (!isApi) {
    const gate = await maintenanceGate(env);
    if (gate.locked) return maintenancePage(gate);
  }

  if (url.pathname.startsWith("/api/")) {
    // state-changing calls only from this page (the webhook is signed instead)
    if (isUnsafeMethod(request) && url.pathname !== "/api/inbound" && !originAllowed(request)) {
      return apiHeaders(json({ error: "Request refused: unknown origin" }, 403));
    }
    try {
      const res = await routeApi(request, env, url);
      return res.headers.get("content-disposition") ? res : apiHeaders(res);
    } catch (err) {
      console.error("api error", url.pathname, err && err.message);
      return apiHeaders(json({ error: "Internal error" }, 500));
    }
  }

  // Everything else → static assets (the single-file frontend). Message
  // images only load after the person asks (see the reader frame's policy).
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) return notFound(request, "Inpriv Temp");
  return pageResponse(request, res, { "img-src": ["https:"], "=frame-src": ["'self'"] });
}

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") {
    return json({ ok: true, service: "inpriv-temp", time: new Date().toISOString() });
  }

  // public maintenance state (used by the frontend to show the info banner)
  if (path === "/api/maintenance") {
    const gate = await maintenanceGate(env);
    return json({ locked: gate.locked, message: gate.message, info: gate.info }, 200);
  }

  if (path === "/api/inbound") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    return handleInbound(request, env);
  }

  if (path === "/api/mailbox") {
    if (method === "POST") return createMailbox(request, env);
    const mailbox = await authMailbox(request, env);
    if (!mailbox) return json({ error: "Invalid or expired mailbox token" }, 401);
    if (method === "GET") {
      const unread = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE mailbox = ? AND read = 0")
        .bind(mailbox.address).first();
      return json({
        address: mailbox.address,
        created_at: mailbox.created_at,
        expires_at: mailbox.expires_at,
        unread: unread?.c ?? 0,
      });
    }
    if (method === "DELETE") {
      await deleteMailbox(env, mailbox.address);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (path === "/api/messages" && method === "GET") {
    const mailbox = await authMailbox(request, env);
    if (!mailbox) return json({ error: "Invalid or expired mailbox token" }, 401);
    const { results } = await env.DB
      .prepare(`SELECT id, from_addr, from_name, subject, received_at, read, size, att_count
                FROM messages WHERE mailbox = ?
                ORDER BY received_at DESC LIMIT 100`)
      .bind(mailbox.address).all();
    return json({ messages: results ?? [] });
  }

  let m = path.match(/^\/api\/messages\/([a-f0-9-]+)$/);
  if (m) {
    const mailbox = await authMailbox(request, env);
    if (!mailbox) return json({ error: "Invalid or expired mailbox token" }, 401);
    const id = m[1];
    if (method === "GET") {
      const row = await env.DB
        .prepare(`SELECT id, from_addr, from_name, to_addr, subject, text, html,
                         attachments, size, received_at, read
                  FROM messages WHERE id = ? AND mailbox = ?`)
        .bind(id, mailbox.address).first();
      if (!row) return json({ error: "Message not found" }, 404);
      if (!row.read) {
        await env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ?").bind(id).run();
        row.read = 1;
      }
      row.attachments = row.attachments ? JSON.parse(row.attachments) : [];
      return json(row);
    }
    if (method === "DELETE") {
      await env.DB
        .prepare("DELETE FROM messages WHERE id = ? AND mailbox = ?")
        .bind(id, mailbox.address).run();
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  m = path.match(/^\/api\/messages\/([a-f0-9-]+)\/attachments\/(\d+)$/);
  if (m && method === "GET") {
    const mailbox = await authMailbox(request, env);
    if (!mailbox) return json({ error: "Invalid or expired mailbox token" }, 401);
    const row = await env.DB
      .prepare("SELECT attachments FROM messages WHERE id = ? AND mailbox = ?")
      .bind(m[1], mailbox.address).first();
    const att = row?.attachments ? JSON.parse(row.attachments)[Number(m[2])] : null;
    if (!att) return json({ error: "Attachment not found" }, 404);
    if (!att.data) {
      return json({ error: "Attachment was larger than the storage limit and was not kept" }, 410);
    }
    const bytes = base64ToBytes(att.data);
    const filename = (att.filename || "attachment").replace(/[^\w.@ -]/g, "_");
    // The sender chose the type and the bytes: always a download, never
    // rendered or sniffed on this origin.
    return withHeaders(new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition":
          `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(att.filename || "attachment")}`,
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "no-store",
      },
    }));
  }

  if (path === "/api/send" && method === "POST") {
    return json({ error: "Outgoing mail is disabled for disposable inboxes." }, 403);
  }

  return json({ error: "Not found" }, 404);
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

async function createMailbox(request, env) {
  const domain = env.DOMAIN || "inpriv.xyz";
  if (!env.ID_DB) return json({ error: "Temp isn't fully configured" }, 503);

  let customLocal = null;
  const body = await request.json().catch(() => ({}));
  if (typeof body.local === "string" && body.local.trim()) {
    customLocal = body.local.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9._-]{0,28}[a-z0-9])?$/.test(customLocal)) {
      return json({ error: "Allowed: 2–30 chars, letters, digits, . _ -" }, 400);
    }
  }

  // creating inboxes costs a permanent address each: limit it per network
  const ipk = clientKey(request);
  if (!(await rateLimit(env.ID_DB, `tempnew:${ipk}`, CREATE_HOURLY_LIMIT, 3_600_000)) ||
      (customLocal && !(await rateLimit(env.ID_DB, `tempcustom:${ipk}`, CUSTOM_HOURLY_LIMIT, 3_600_000)))) {
    return json({ error: "Too many new inboxes from your network — try again in an hour" }, 429);
  }

  await ensureClaims(env.ID_DB);
  await backfillIdClaims(env.ID_DB);
  if (customLocal) {
    // One answer for every name that isn't free (reserved, an account, an
    // earlier Temp inbox), so this can't be used to look up accounts.
    let taken = isReservedLocal(customLocal);
    if (!taken) {
      taken = !!(await env.ID_DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(customLocal).first());
    }
    if (!taken) {
      taken = !!(await env.ID_DB.prepare("SELECT 1 FROM retired_usernames WHERE username = ?")
        .bind(customLocal).first().catch(() => null)); // table appears with the first deleted account
    }
    if (!taken) {
      taken = !!(await env.DB.prepare("SELECT 1 FROM mailboxes WHERE address = ?").bind(`${customLocal}@${domain}`).first());
    }
    if (taken || !(await tryClaim(env.ID_DB, customLocal, "temp"))) {
      return json({ error: "That address isn't available — try another" }, 409);
    }
  }

  const now = Date.now();
  const expiresAt = now + MAILBOX_TTL_MS;

  for (let attempt = 0; attempt < 6; attempt++) {
    const local = customLocal ?? tempLocal();
    // the claim is the authority: a name someone already holds is skipped
    if (!customLocal && !(await tryClaim(env.ID_DB, local, "temp"))) continue;
    const address = `${local}@${domain}`;
    const token = randomHex(16);
    await env.DB
      .prepare("INSERT INTO mailboxes (address, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(address, await sha256Hex(token), now, expiresAt)
      .run();
    return json({ address, token, created_at: now, expires_at: expiresAt }, 201);
  }
  return json({ error: "Could not allocate an address, try again" }, 500);
}

// Short-lived counters in the inpriv-id database (rl_counters, with expiry).
async function rateLimit(db, key, limit, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  try {
    const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, bucket).first();
    if (row && row.c >= limit) return false;
    await db.prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?,?,1,?) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1")
      .bind(key, bucket, (bucket + 1) * windowMs).run();
  } catch { /* fail open: Temp stays usable if the counter table is busy */ }
  return true;
}

async function authMailbox(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^[a-f0-9]{16,64}$/.test(token)) return null;
  const row = await env.DB
    .prepare("SELECT address, token_hash, created_at, expires_at FROM mailboxes WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

async function deleteMailbox(env, address) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE mailbox = ?").bind(address),
    env.DB.prepare("DELETE FROM sends WHERE mailbox = ?").bind(address),
    env.DB.prepare("DELETE FROM mailboxes WHERE address = ?").bind(address),
  ]);
}

// ── Outbound (Resend) ────────────────────────────────────────────────────────

async function sendMessage(request, env) {
  const mailbox = await authMailbox(request, env);
  if (!mailbox) return json({ error: "Invalid or expired mailbox token" }, 401);

  const body = await request.json().catch(() => ({}));
  const to = String(body.to || "").trim().toLowerCase();
  const subject = String(body.subject || "").slice(0, 200).trim();
  const text = String(body.text || "").slice(0, 50_000).trimEnd();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: "Invalid recipient address" }, 400);
  if (!text) return json({ error: "Message body is empty" }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "Sending is not configured on the server" }, 503);

  const hourAgo = Date.now() - 60 * 60 * 1000;
  const sent = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM sends WHERE mailbox = ? AND at > ?")
    .bind(mailbox.address, hourAgo)
    .first();
  if ((sent?.c ?? 0) >= SEND_HOURLY_LIMIT) {
    return json({ error: `Hourly send limit reached (${SEND_HOURLY_LIMIT})` }, 429);
  }

  let resend;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: mailbox.address, to, subject: subject || "(no subject)", text }),
    });
    resend = { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return json({ error: "Could not reach the mail relay — try again" }, 502);
  }

  if (resend.status >= 400) {
    // Surface Resend's own message ("domain not verified", rate limits, …)
    return json({ error: resend.body?.message || "The mail relay rejected this send" }, 502);
  }

  await env.DB
    .prepare("INSERT INTO sends (mailbox, at, message_id) VALUES (?, ?, ?)")
    .bind(mailbox.address, Date.now(), resend.body?.id ?? null)
    .run();
  return json({ ok: true, id: resend.body?.id ?? null });
}

// ── Inbound (Resend webhook `email.received`) ────────────────────────────────

async function handleInbound(request, env) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: "Inbound not configured: set RESEND_WEBHOOK_SECRET" }, 503);
  }

  // Verify the svix signature against the RAW body (never a re-serialized copy).
  const raw = await request.text();
  const svixId = request.headers.get("svix-id") || "";
  const svixTs = request.headers.get("svix-timestamp") || "";
  const svixSig = request.headers.get("svix-signature") || "";

  if (!(await verifySvix(secret, svixId, svixTs, svixSig, raw))) {
    return json({ error: "Invalid webhook signature" }, 401);
  }

  const ts = Number(svixTs);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SVIX_TOLERANCE_S) {
    return json({ error: "Webhook timestamp outside tolerance" }, 400);
  }

  // Svix delivers at least once: a delivery already stored is acknowledged
  // and not stored again (the id is kept two days, in rl_counters)
  const seenKey = `svix:temp:${svixId}`;
  if (env.ID_DB) {
    const seen = await env.ID_DB.prepare("SELECT 1 FROM rl_counters WHERE k = ?").bind(seenKey).first().catch(() => null);
    if (seen) return json({ ok: true, duplicate: true });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (event.type !== "email.received") {
    return json({ ok: true, ignored: event.type || "unknown" });
  }

  const d = event.data || {};
  const domain = env.DOMAIN || "inpriv.xyz";
  const emailId = String(d.email_id || "");

  // A catch-all webhook fires for EVERY address at the domain. Only mail for a
  // live, unexpired mailbox is stored; everything else is silently accepted
  // (200) so Resend does not retry and addresses cannot be enumerated.
  const recipients = [
    ...(Array.isArray(d.to) ? d.to : []),
    ...(Array.isArray(d.received_for) ? d.received_for : []),
  ].map((s) => String(s).trim().toLowerCase()).filter(Boolean);

  let target = null;
  for (const r of recipients) {
    if (!r.endsWith("@" + domain)) continue;
    const row = await env.DB
      .prepare("SELECT address FROM mailboxes WHERE address = ? AND expires_at > ?")
      .bind(r, Date.now())
      .first();
    if (row) { target = r; break; }
  }
  if (!target) return json({ ok: true, ignored: "no live mailbox" });

  if (!emailId) return json({ error: "Missing email_id" }, 400);

  // Webhooks carry metadata only — fetch body + headers via the Received API.
  // RESEND_READ_API_KEY needs read access (a send-only key gets 401); the
  // message is still stored with metadata if reading is unavailable.
  const readKey = env.RESEND_READ_API_KEY || env.RESEND_API_KEY || "";
  let text = null, html = null, fromName = null, size = 0;
  const atts = [];

  if (readKey) {
    try {
      const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      if (res.ok) {
        const email = await res.json();
        text = (email.text || "").slice(0, MAX_TEXT_CHARS) || null;
        html = (email.html || "").slice(0, MAX_HTML_CHARS) || null;
        size = (text?.length ?? 0) + (html?.length ?? 0);
        const hf = email.headers?.from || "";
        const nm = hf.match(/^[^<]+(?=\s*<)/);
        if (nm) fromName = nm[0].trim().replace(/^"|"$/g, "").slice(0, 200) || null;
      } else if (res.status === 401) {
        console.error("inbound: read key is not read-capable (401) — storing metadata only");
      } else {
        console.error(`inbound: content fetch ${res.status}`);
      }
    } catch (err) {
      console.error("inbound: content fetch failed", err);
    }
  }

  // Attachments: list metadata + download small ones (≤512 KB each, ≤2 MB total).
  if (readKey) {
    try {
      const res = await fetch(
        `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
        { headers: { Authorization: `Bearer ${readKey}` } },
      );
      if (res.ok) {
        const list = await res.json();
        let attTotal = 0;
        for (const a of list.data || []) {
          const meta = {
            filename: (a.filename || "attachment").slice(0, 200),
            contentType: a.content_type || "application/octet-stream",
            size: a.size || 0,
          };
          const asize = a.size || 0;
          if (asize > 0 && asize <= MAX_ATT_PER_FILE && attTotal + asize <= MAX_ATT_TOTAL && a.download_url) {
            const dl = await fetch(a.download_url);
            if (dl.ok) {
              const buf = new Uint8Array(await dl.arrayBuffer());
              meta.data = bytesToBase64(buf);
              meta.size = buf.length;
              attTotal += buf.length;
            } else {
              meta.dropped = true;
            }
          } else if (asize > 0) {
            meta.dropped = true; // visible in the UI, downloadable never
          }
          atts.push(meta);
        }
      }
    } catch (err) {
      console.error("inbound: attachment fetch failed", err);
    }
  }

  // Fallback: attachment metadata straight from the webhook payload.
  if (!atts.length && Array.isArray(d.attachments) && d.attachments.length) {
    for (const a of d.attachments) {
      atts.push({
        filename: (a.filename || "attachment").slice(0, 200),
        contentType: a.content_type || "application/octet-stream",
        size: 0,
        dropped: true,
      });
    }
  }

  // active content (scripts, frames, forms, handlers) is removed before
  // storing; remote images are blocked later, in the reader
  if (html) {
    try {
      html = (await sanitizeEmailHtml(html)) || null;
    } catch {
      console.error("inbound: html sanitize failed — storing text only");
      html = null;
    }
  }

  const record = {
    id: crypto.randomUUID(),
    mailbox: target,
    from_addr: String(d.from || "unknown@unknown").toLowerCase().slice(0, 320),
    from_name: fromName,
    to_addr: target,
    subject: (String(d.subject || "(no subject)")).slice(0, 500),
    text,
    html,
    message_id: d.message_id || null,
    received_at: Date.now(),
    size,
    att_count: atts.length,
  };

  try {
    await insertMessage(env, record, atts.length ? JSON.stringify(atts) : null);
  } catch (err) {
    console.error("store failed, retrying minimal", err);
    try {
      await insertMessage(env, { ...record, html: null, text: null, att_count: 0 }, null);
    } catch (err2) {
      console.error("store failed entirely", err2);
      return json({ error: "Storage failure" }, 500); // 500 → Resend retries the webhook
    }
  }
  if (env.ID_DB) {
    await env.ID_DB.prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?, 0, 1, ?) ON CONFLICT(k, bucket) DO NOTHING")
      .bind(seenKey, Date.now() + 2 * 86_400_000).run().catch(() => {});
  }
  return json({ ok: true, stored: true });
}

async function insertMessage(env, r, attachmentsJson) {
  await env.DB
    .prepare(`INSERT INTO messages
              (id, mailbox, from_addr, from_name, to_addr, subject, text, html,
               att_count, attachments, size, message_id, received_at, read)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .bind(r.id, r.mailbox, r.from_addr, r.from_name, r.to_addr, r.subject, r.text,
          r.html, r.att_count ?? 0, attachmentsJson, r.size, r.message_id, r.received_at)
    .run();
}

// ── Svix webhook verification (Standard Webhooks) ────────────────────────────

async function verifySvix(secret, svixId, svixTs, svixSigHeader, rawBody) {
  if (!secret || !svixId || !svixTs || !svixSigHeader || typeof rawBody !== "string") return false;

  const b64Secret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw", base64ToBytes(b64Secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  } catch {
    return false;
  }
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${svixId}.${svixTs}.${rawBody}`));
  const expected = bytesToBase64(new Uint8Array(mac));

  for (const part of svixSigHeader.split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    if (version === "v1" && timingSafeEqualStr(sig, expected)) return true;
  }
  return false;
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Cron cleanup ─────────────────────────────────────────────────────────────

async function handleScheduled(_event, env) {
  const now = Date.now();
  // Address claims first: every live inbox, and once, every Temp address the
  // access log still remembers (it kept "inbox created" rows until the
  // October 2026 change). Older expired addresses can't be listed any more;
  // the retired name pattern (common/addresses.js) covers the generated ones.
  try {
    await ensureClaims(env.ID_DB);
    await backfillIdClaims(env.ID_DB);
    const live = await env.DB.prepare("SELECT address FROM mailboxes").all();
    await claimMany(env.ID_DB, (live.results ?? []).map((r) => r.address.split("@")[0]), "temp");
    if (!(await env.ID_DB.prepare("SELECT 1 FROM app_meta WHERE k = 'claims_backfill_temp_v1'").first())) {
      const seen = await env.ID_DB.prepare(
        "SELECT DISTINCT account FROM access_log WHERE service = 'temp' AND event = 'inbox_created' AND account LIKE '%@inpriv.xyz'"
      ).all().catch(() => ({ results: [] }));
      await claimMany(env.ID_DB, (seen.results ?? []).map((r) => String(r.account).split("@")[0]), "temp");
      await env.ID_DB.prepare("INSERT OR REPLACE INTO app_meta (k, v) VALUES ('claims_backfill_temp_v1', ?)").bind(String(now)).run();
    }
  } catch (err) {
    console.error("claims backfill (temp) failed", err && err.message);
  }
  // retention for the inpriv-id database (access log, counters, tickets)
  await purgeAccessLog(env.ID_DB, env);
  const staleMessageCutoff = now - MESSAGE_RETENTION_MS;

  const expired = await env.DB
    .prepare("SELECT address FROM mailboxes WHERE expires_at < ?").bind(now).all();
  const addresses = (expired.results ?? []).map((r) => r.address);

  const stmts = [
    env.DB.prepare("DELETE FROM messages WHERE mailbox NOT IN (SELECT address FROM mailboxes)"),
    env.DB.prepare("DELETE FROM sends WHERE at < ?").bind(now - 7 * 24 * 60 * 60 * 1000),
    env.DB.prepare("DELETE FROM messages WHERE received_at < ?").bind(staleMessageCutoff),
    env.DB.prepare("DELETE FROM mailboxes WHERE expires_at < ?").bind(now),
  ];
  if (addresses.length) {
    stmts.unshift(env.DB
      .prepare(`DELETE FROM messages WHERE mailbox IN (${addresses.map(() => "?").join(",")})`)
      .bind(...addresses));
  }
  const out = await env.DB.batch(stmts);
  console.log(`cleanup: swept ${addresses.length} expired mailbox(es)`, out.map((r) => r.meta?.changes ?? 0));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
