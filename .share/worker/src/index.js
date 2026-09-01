// ── Inpriv Share — signaling relay (Cloudflare Worker + KV) ──────────────────
// Zero-knowledge relay for WebRTC signaling. Rooms are opaque ids; every
// payload after hello is AES-GCM sealed client-side (ECDH P-256), so the
// relay never sees ICE candidates, IPs or SDP. Rooms self-destruct (TTL),
// are single-use, and can be burned by the sender after transfer.
//
// KV layout (SHARE_KV):
//   room:<id>          → JSON { pub, created }         (TTL ~15 min)
//   room:<id>:<n>      → JSON { from, data }           (TTL ~15 min, n = 1,2,…)
//   room:<id>:count    → counter for n
//
// All state is ephemeral. No logs, no analytics, no IPs stored.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PUB_RE = /^[A-Za-z0-9+/=]{80,200}$/;   // b64 SPKI-ish raw point (P-256 raw ~65 b64 chars; be lenient)
const ROOM_TTL = 900;       // 15 min
const SIGNAL_TTL = 600;     // 10 min
const MAX_SIGNALS = 60;     // signaling needs <20 messages; hard cap
const MAX_PAYLOAD = 16000;  // SDP + candidates fit easily
const MAX_BODY = 32000;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

async function readJson(request) {
  try {
    const ct = request.headers.get("Content-Type") || "";
    if (!ct.includes("application/json")) return null;
    const raw = await request.text();
    if (raw.length > MAX_BODY) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const gate = await maintenanceGate("share");
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage("Inpriv Share", gate.message);
    }

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (!env.SHARE_KV) return json({ error: "kv_not_bound" }, 500);

    // ─── POST /api/rooms — create a room ───
    if (method === "POST" && path === "/api/rooms") {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const { id, pub, ttl } = body;
      if (typeof id !== "string" || !ID_RE.test(id)) return json({ error: "invalid id" }, 400);
      if (typeof pub !== "string" || !PUB_RE.test(pub)) return json({ error: "invalid pub" }, 400);
      const roomTtl = Math.min(Math.max(parseInt(ttl, 10) || ROOM_TTL, 60), 3600);

      const existing = await env.SHARE_KV.get(`room:${id}`);
      if (existing) return json({ error: "room exists" }, 409);

      await env.SHARE_KV.put(`room:${id}`, JSON.stringify({ pub, created: Date.now() }), {
        expirationTtl: roomTtl,
      });
      return json({ ok: true, ttl: roomTtl });
    }

    // ─── GET /api/rooms/:id — fetch room pubkey (receiver) ───
    const mRoom = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})$/);
    if (method === "GET" && mRoom) {
      const raw = await env.SHARE_KV.get(`room:${mRoom[1]}`);
      if (!raw) return json({ error: "not found" }, 404);
      const room = JSON.parse(raw);
      return json({ pub: room.pub });
    }

    // ─── POST /api/rooms/:id/signals — push a signal ───
    const mSig = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})\/signals$/);
    if (method === "POST" && mSig) {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const { from, data } = body;
      if (from !== "s" && from !== "r") return json({ error: "invalid from" }, 400);
      if (typeof data !== "string" || data.length === 0 || data.length > MAX_PAYLOAD) {
        return json({ error: "invalid payload" }, 400);
      }
      const id = mSig[1];
      const roomRaw = await env.SHARE_KV.get(`room:${id}`);
      if (!roomRaw) return json({ error: "not found" }, 404);

      const cntRaw = await env.SHARE_KV.get(`room:${id}:count`);
      const n = (parseInt(cntRaw, 10) || 0) + 1;
      if (n > MAX_SIGNALS) return json({ error: "too many signals" }, 429);
      await env.SHARE_KV.put(`room:${id}:signals:${n}`, JSON.stringify({ from, data }), {
        expirationTtl: SIGNAL_TTL,
      });
      await env.SHARE_KV.put(`room:${id}:count`, String(n), { expirationTtl: SIGNAL_TTL });
      return json({ ok: true, n });
    }

    // ─── GET /api/rooms/:id/signals?from=s|&after=N — poll signals ───
    if (method === "GET" && mSig) {
      const id = mSig[1];
      const from = url.searchParams.get("from") || "";
      const after = parseInt(url.searchParams.get("after"), 10) || 0;
      if (from !== "s" && from !== "r") return json({ error: "invalid from" }, 400);
      const roomRaw = await env.SHARE_KV.get(`room:${id}`);
      if (!roomRaw) return json({ error: "not found" }, 404);

      const cntRaw = await env.SHARE_KV.get(`room:${id}:count`);
      const count = Math.min(parseInt(cntRaw, 10) || 0, MAX_SIGNALS);
      const signals = [];
      for (let n = after + 1; n <= count && signals.length < 40; n++) {
        const raw = await env.SHARE_KV.get(`room:${id}:signals:${n}`);
        if (raw) {
          const sig = JSON.parse(raw);
          if (sig.from !== from) signals.push({ n, data: sig.data });
        }
      }
      return json({ signals, count });
    }

    // ─── POST /api/rooms/:id/burn — sender destroys the room ───
    const mBurn = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})\/burn$/);
    if (method === "POST" && mBurn) {
      const id = mBurn[1];
      const keys = [];
      let cur = "";
      for (;;) {
        const page = await env.SHARE_KV.list({ prefix: `room:${id}`, cursor: cur || undefined, limit: 100 });
        for (const k of page.keys) keys.push(k.name);
        if (page.list_complete || !page.cursor) break;
        cur = page.cursor;
      }
      await Promise.all(keys.map((k) => env.SHARE_KV.delete(k)));
      return json({ ok: true, removed: keys.length });
    }

    // ─── GET /api/health — always passes (monitoring) ───
    if (path === "/api/health") return json({ ok: true });

    // ─── everything else: static frontend (single-file app) ───
    return env.ASSETS.fetch(request);
  },
};
