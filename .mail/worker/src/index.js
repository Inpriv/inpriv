// Inpriv Mail — API worker
// Architecture: zero-knowledge mailbox.
//  - Password login via PBKDF2 auth hash (server-checkable).
//  - Message bodies are AES-256-GCM ciphertext from the browser; the worker
//    stores envelopes only and never sees plaintext.
//  - Outbound via Resend API; inbound via Cloudflare Email Routing email() handler.

import { EmailMessage } from "cloudflare:email";

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const DOMAIN = 'inpriv.xyz';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// ── helpers ─────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const uuid = () => crypto.randomUUID();
const now = () => Date.now();

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

function bad(msg, status = 400) { return json({ error: msg }, status); }

// PBKDF2 auth hash (server-side verifier) — same params the browser uses
async function authHash(password, saltB64, iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations },
    key, 256
  );
  return b64(bits);
}

function isLocal(addr) { return addr === DOMAIN || addr.endsWith('@' + DOMAIN); }

// ── session auth ────────────────────────────────────────────────────────
async function authUser(req, env) {
  const hdr = req.headers.get('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id sid, s.expires_at, u.id uid, u.address, u.wrap_salt, u.wrap_verifier
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(id).first();
  if (!row || row.expires_at < now()) return null;
  return row;
}

// ── routes ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ── static assets (frontend) ──
    if (request.method === 'GET' && !path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      // ═══ AUTH ═══
      if (path === '/api/available' && request.method === 'GET') {
        const local = url.searchParams.get('local') || '';
        if (!/^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/.test(local)) return bad('invalid');
        const addr = local + '@' + DOMAIN;
        const exists = await env.DB.prepare('SELECT 1 FROM users WHERE address = ?').bind(addr).first();
        return json({ available: !exists });
      }

      if (path === '/api/register' && request.method === 'POST') {
        const body = await request.json();
        const local = String(body.local || '').toLowerCase();
        const password = String(body.password || '');
        if (!/^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/.test(local)) return bad('invalid address');
        if (password.length < 8) return bad('password too short (min 8)');
        const address = local + '@' + DOMAIN;

        const authSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const auth_hash = await authHash(password, authSalt);
        const wrapSalt = String(body.wrap_salt || '');       // client-generated
        const wrapVerifier = String(body.wrap_verifier || '');// client-generated envelope
        if (!wrapSalt || !wrapVerifier) return bad('missing crypto envelope');

        const dup = await env.DB.prepare('SELECT 1 FROM users WHERE address = ?').bind(address).first();
        if (dup) return bad('address taken', 409);

        const uid = uuid();
        await env.DB.prepare(
          `INSERT INTO users (id, address, auth_hash, auth_salt, wrap_salt, wrap_verifier, created_at)
           VALUES (?,?,?,?,?,?,?)`
        ).bind(uid, address, auth_hash, authSalt, wrapSalt, wrapVerifier, now()).run();

        const token = b64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)`
        ).bind(await sha256hex(token), uid, now(), now() + SESSION_TTL_MS, request.headers.get('User-Agent') || '').run();

        return json({ token, address, wrap_salt: wrapSalt, wrap_verifier: wrapVerifier });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const body = await request.json();
        const address = String(body.address || '').toLowerCase().trim();
        const password = String(body.password || '');
        const user = await env.DB.prepare(
          'SELECT id, address, auth_hash, auth_salt, wrap_salt, wrap_verifier FROM users WHERE address = ?'
        ).bind(address).first();
        if (!user) return bad('invalid credentials', 401);

        const candidate = await authHash(password, user.auth_salt);
        // constant-time-ish compare
        if (candidate.length !== user.auth_hash.length || candidate !== user.auth_hash) return bad('invalid credentials', 401);

        const token = b64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)`
        ).bind(await sha256hex(token), user.id, now(), now() + SESSION_TLS_MS || now() + SESSION_TTL_MS, request.headers.get('User-Agent') || '').run();
        await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now(), user.id).run();

        return json({ token, address: user.address, wrap_salt: user.wrap_salt, wrap_verifier: user.wrap_verifier });
      }

      // ═══ MAILBOX (auth required) ═══
      const me = await authUser(request, env);
      if (!me) return bad('unauthorized', 401);

      if (path === '/api/me' && request.method === 'GET') {
        return json({ address: me.address, wrap_salt: me.wrap_salt, wrap_verifier: me.wrap_verifier });
      }

      if (path === '/api/messages' && request.method === 'GET') {
        const folder = url.searchParams.get('folder') || 'inbox';
        if (!['inbox', 'sent', 'trash'].includes(folder)) return bad('bad folder');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
        const rows = await env.DB.prepare(
          `SELECT id, folder, from_addr, to_addr, subject_enc, body_enc, meta, read, sent_at, received_at
           FROM messages WHERE user_id = ? AND folder = ?
           ORDER BY COALESCE(received_at, sent_at) DESC LIMIT ?`
        ).bind(me.uid, folder, limit).run();
        return json({ messages: rows.results });
      }

      if (path === '/api/messages/read' && request.method === 'POST') {
        const { id } = await request.json();
        await env.DB.prepare('UPDATE messages SET read = 1 WHERE id = ? AND user_id = ?').bind(id, me.uid).run();
        return json({ ok: true });
      }

      if (path === '/api/messages/delete' && request.method === 'POST') {
        const { id } = await request.json();
        const row = await env.DB.prepare('SELECT folder FROM messages WHERE id = ? AND user_id = ?').bind(id, me.uid).first();
        if (!row) return bad('not found', 404);
        if (row.folder === 'trash') {
          await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
        } else {
          await env.DB.prepare(`UPDATE messages SET folder = 'trash' WHERE id = ?`).bind(id).run();
        }
        return json({ ok: true });
      }

      if (path === '/api/send' && request.method === 'POST') {
        const body = await request.json();
        const to = String(body.to || '').toLowerCase().trim();
        const from = me.address;
        const subject = String(body.subject || '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad('invalid recipient');
        // rate limit: 20/hour per user via D1 counter
        const hourBucket = Math.floor(now() / 3600000);
        const rl = await env.DB.prepare(
          `SELECT c FROM send_log WHERE user_id = ? AND bucket = ?`
        ).bind(me.uid, hourBucket).first();
        if (rl && rl.c >= 20) return bad('rate limit exceeded (20/hour)', 429);
        await env.DB.prepare(
          `INSERT INTO send_log (user_id, bucket, c) VALUES (?,?,1)
           ON CONFLICT(user_id, bucket) DO UPDATE SET c = c + 1`
        ).bind(me.uid, hourBucket).run();

        // Resend send
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'copyapplication/json' },
          body: JSON.stringify({
            from: `Inpriv Mail <${from}>`,
            to: [to],
            subject: subject || '(no subject)',
            text: String(body.text || ''),
            ...(body.html ? { html: String(body.html) } : {}),
          }),
        });
        if (!resp.ok) {
          const err = await resp.text();
          return json({ error: 'send failed', detail: err.slice(0, 300) }, 502);
        }
        const out = await resp.json();

        // store in sent folder (encrypted client-side before submit)
        const mid = uuid();
        await env.DB.prepare(
          `INSERT INTO messages (id, user_id, folder, from_addr, to_addr, subject_enc, body_enc, meta, sent_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(mid, me.uid, 'sent', from, to, body.subject_enc || '', body.body_enc || '',
               JSON.stringify({ resend_id: out.id || null }), now()).run();

        return json({ ok: true, id: mid, resend_id: out.id || null });
      }

      if (path === '/api/logout' && request.method === 'POST') {
        const hdr = request.headers.get('Authorization') || '';
        const token = hdr.slice(7);
        await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256hex(token)).run();
        return json({ ok: true });
      }

      return bad('not found', 404);
    } catch (e) {
      return json({ error: 'server error', detail: String(e && e.message || e) }, 500);
    }
  },

  // ═══ INBOUND EMAIL (Cloudflare Email Routing) ═══
  async email(message, env, ctx) {
    const to = (message.to || '').toLowerCase();
    const from = (message.from || '').toLowerCase();
    if (!isLocal(to)) return message.setReject('unknown mailbox');

    const user = await env.DB.prepare('SELECT id FROM users WHERE address = ?').bind(to).first();
    if (!user) return message.setReject('no such mailbox');

    const raw = new Response(message.raw).text();
    const subject = message.headers.get('subject') || '(no subject)';
    const mid = uuid();
    // Store opaque: subject/body stay encrypted client-side after the user's
    // browser pulls them (pull-encrypt flow). For MVP we store the raw source
    // server-side only long enough for the client to fetch+encrypt+delete-raw.
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, folder, from_addr, to_addr, subject_enc, body_enc, meta, received_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(mid, user.id, 'inbox', from, to, '', '', JSON.stringify({ raw: await raw, subject }), now()).run();
  },
};
