// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Temp — disposable email addresses on inpriv.xyz
//
// Cloudflare Email Routing (catch-all) → email() handler → D1.
// Mailboxes are created on demand, live for 24 h, and can be destroyed with
// one click. Outbound mail goes through the Resend API (restricted send key).
// ─────────────────────────────────────────────────────────────────────────────

import PostalMime from "postal-mime";

const MAILBOX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h, then cron sweeps it away
const MAX_RAW_BYTES = 20 * 1024 * 1024;     // reject messages above 20 MB
const MAX_TEXT_CHARS = 100_000;
const MAX_HTML_CHARS = 300_000;
const MAX_ATT_PER_FILE = 512 * 1024;        // larger attachments are listed, not stored
const MAX_ATT_TOTAL = 2 * 1024 * 1024;
const SEND_HOURLY_LIMIT = 10;
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // hard cap for stored messages

// Local parts that must never become disposable mailboxes.
const RESERVED = new Set([
  "abuse", "admin", "administrator", "hostmaster", "mail", "mailer-daemon",
  "no-reply", "noreply", "postmaster", "root", "security", "support", "webmaster",
]);

const ADJECTIVES = [
  "amber", "ashen", "azure", "basalt", "birch", "bright", "calm", "cipher",
  "cobalt", "copper", "coral", "crimson", "dusk", "ember", "fern", "flint",
  "frost", "glade", "granite", "harbor", "indigo", "ivory", "jade", "juniper",
  "linen", "maple", "marsh", "moss", "neon", "noble", "opal", "pearl",
  "pine", "quartz", "raven", "ridge", "rift", "river", "sable", "sage",
  "slate", "spruce", "summit", "tundra", "velvet", "violet", "willow", "wren",
];
const NOUNS = [
  "anchor", "atlas", "badger", "beacon", "bison", "bolt", "bonsai", "breeze",
  "cactus", "canyon", "cedar", "cinder", "cliff", "cloud", "comet", "cove",
  "crane", "dune", "eagle", "echo", "falcon", "fjord", "fox", "gazelle",
  "gecko", "glacier", "hawk", "heron", "ibex", "jay", "koala", "lantern",
  "lemur", "lynx", "marten", "moth", "ocelot", "otter", "panda", "puffin",
  "quail", "raven", "rocket", "salmon", "seal", "shadow", "sparrow", "tiger",
  "urchin", "viper", "vulture", "walrus", "wolf", "zebra",
];

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  async email(message, env, ctx) {
    return handleEmail(message, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  },
};

// ── HTTP API ─────────────────────────────────────────────────────────────────

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    try {
      return await routeApi(request, env, url);
    } catch (err) {
      console.error("api error", err);
      return json({ error: "Internal error" }, 500);
    }
  }

  // Everything else → static assets (the single-file frontend).
  return env.ASSETS.fetch(request);
}

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

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
    return new Response(bytes, {
      headers: {
        "content-type": att.contentType || "application/octet-stream",
        "content-disposition":
          `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(att.filename || "attachment")}`,
      },
    });
  }

  if (path === "/api/send" && method === "POST") return sendMessage(request, env);

  return json({ error: "Not found" }, 404);
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

async function createMailbox(request, env) {
  const domain = env.DOMAIN || "inpriv.xyz";

  let customLocal = null;
  const body = await request.json().catch(() => ({}));
  if (typeof body.local === "string" && body.local.trim()) {
    customLocal = body.local.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9._-]{0,28}[a-z0-9])?$/.test(customLocal)) {
      return json({ error: "Allowed: 2–30 chars, letters, digits, . _ -" }, 400);
    }
    if (RESERVED.has(customLocal)) {
      return json({ error: "That address is reserved" }, 409);
    }
  }

  const now = Date.now();
  const expiresAt = now + MAILBOX_TTL_MS;

  for (let attempt = 0; attempt < 6; attempt++) {
    const local = customLocal ?? randomLocal();
    const address = `${local}@${domain}`;
    const token = randomHex(16);
    try {
      await env.DB
        .prepare("INSERT INTO mailboxes (address, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(address, await sha256Hex(token), now, expiresAt)
        .run();
      return json({ address, token, created_at: now, expires_at: expiresAt }, 201);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("UNIQUE")) {
        if (customLocal) return json({ error: "That address is already taken — try another" }, 409);
        continue; // generated name collided, roll again
      }
      throw err;
    }
  }
  return json({ error: "Could not allocate an address, try again" }, 500);
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

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "Invalid recipient address" }, 400);
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

// ── Inbound (Email Routing) ──────────────────────────────────────────────────

async function handleEmail(message, env) {
  const domain = env.DOMAIN || "inpriv.xyz";
  const to = (message.to || "").toLowerCase();
  const local = to.split("@")[0];

  if (!to.endsWith("@" + domain) || !local) {
    message.setReject("550 5.7.1 Relay not permitted");
    return;
  }

  const mailbox = await env.DB
    .prepare("SELECT address, expires_at FROM mailboxes WHERE address = ?")
    .bind(to)
    .first();

  if (!mailbox || mailbox.expires_at < Date.now()) {
    // Only mail for live, generated mailboxes is accepted — everything else bounces.
    message.setReject(`550 5.1.1 Mailbox <${to}> does not exist`);
    return;
  }

  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("552 5.3.4 Message exceeds the 20 MB limit");
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw);

  const fromName = parsed.from?.name?.slice(0, 200) || null;
  const fromAddr = parsed.from?.address?.toLowerCase() || (message.from || "unknown@unknown").toLowerCase();
  const subject = (parsed.subject || "(no subject)").slice(0, 500);
  const text = (parsed.text || "").slice(0, MAX_TEXT_CHARS);
  const html = (parsed.html || "").slice(0, MAX_HTML_CHARS);

  const attachments = [];
  let attTotal = 0;
  for (const a of parsed.attachments || []) {
    const size = a.content?.byteLength ?? a.size ?? 0;
    const meta = {
      filename: (a.filename || "attachment").slice(0, 200),
      contentType: a.mimeType || "application/octet-stream",
      size,
    };
    if (size > 0 && size <= MAX_ATT_PER_FILE && attTotal + size <= MAX_ATT_TOTAL) {
      meta.data = bytesToBase64(new Uint8Array(a.content));
      attTotal += size;
    } else if (size > 0) {
      meta.dropped = true; // visible in the UI, downloadable never
    }
    attachments.push(meta);
  }

  const record = {
    id: crypto.randomUUID(),
    mailbox: to,
    from_addr: fromAddr,
    from_name: fromName,
    to_addr: to,
    subject,
    text,
    html,
    attachments: attachments.length ? JSON.stringify(attachments) : null,
    att_count: attachments.length,
    size: message.rawSize,
    message_id: message.headers.get("message-id") || null,
    received_at: Date.now(),
  };

  try {
    await insertMessage(env, record, attachments.length ? JSON.stringify(attachments) : null);
  } catch (err) {
    console.error("store failed, retrying minimal", err);
    try {
      await insertMessage(env, { ...record, html: null, attachments: null, att_count: 0 }, null);
    } catch (err2) {
      console.error("store failed entirely", err2);
      message.setReject("451 4.3.0 Temporary storage failure — try again");
    }
  }
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

// ── Cron cleanup ─────────────────────────────────────────────────────────────

async function handleScheduled(_event, env) {
  const now = Date.now();
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

function randomLocal() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 1000);
  return `${adj}-${noun}-${num}`;
}

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
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
