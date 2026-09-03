// ── Inpriv Share — signaling relay (Cloudflare Worker + Google Drive) ────────
// Zero-knowledge relay for WebRTC signaling. Rooms are opaque ids; every
// payload after hello is AES-GCM sealed client-side (ECDH P-256), so the
// relay never sees ICE candidates, IPs or SDP. Rooms self-destruct (TTL),
// are single-use, and can be burned by the sender after transfer.
//
// Storage: Google Drive folder "inpriv/.share" — ONE file per room:
//   room_<id>.json → { pub, created, expiresAt, log: [{ f, d }, ...] }
// The whole signaling conversation (hello, offer, answer, ICE candidates)
// is an append-only log inside that single file. One Drive read per poll,
// one read-modify-write per push — no per-signal file churn.
//
// All state is ephemeral. No logs, no analytics, no IPs stored.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";
import { kvPut, kvGet, kvDeleteId, kvList } from "../../../common/drive.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PUB_RE = /^[A-Za-z0-9+/=]{80,200}$/;   // b64 SPKI raw point (P-256 ~65 b64 chars; be lenient)
const ROOM_TTL = 900;       // 15 min
const MAX_LOG = 120;        // hello + offer/answer + ICE trickle fits easily
const MAX_SIGNAL_DATA = 16000;  // SDP + candidates fit easily
const MAX_BODY = 32000;

const roomName = (id) => `room_${id}.json`;

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

// Load the room record (or null). File names carry expiry for the sweeper.
async function loadRoom(env, id) {
  const raw = await kvGet(env, roomName(id));
  if (raw == null) return null;
  try {
    const room = JSON.parse(raw);
    if (!room || !Array.isArray(room.log)) return null;
    return room;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Lazy sweep: ~4% of requests clean expired rooms (no cron slots left on
    // the Free plan; expected once per ~25 requests).
    if (Math.random() < 0.04 && ctx?.waitUntil) {
      ctx.waitUntil(sweepExpired(env).catch(() => {}));
    }

    const gate = await maintenanceGate("share");
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage("Inpriv Share", gate.message);
    }

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ─── POST /api/sweep — internal, called from admin with shared secret ───
    if (method === "POST" && path === "/api/sweep") {
      const h = request.headers.get("X-Sweep-Secret") || "";
      if (!env.SWEEP_SECRET || h !== env.SWEEP_SECRET) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, removed: await sweepExpired(env) });
    }

    // ─── POST /api/rooms — create a room ───
    if (method === "POST" && path === "/api/rooms") {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const { id, pub, ttl } = body;
      if (typeof id !== "string" || !ID_RE.test(id)) return json({ error: "invalid id" }, 400);
      if (typeof pub !== "string" || !PUB_RE.test(pub)) return json({ error: "invalid pub" }, 400);
      const roomTtl = Math.min(Math.max(parseInt(ttl, 10) || ROOM_TTL, 60), 3600);

      const existing = await loadRoom(env, id);
      if (existing && (existing.expiresAt || 0) > Date.now()) return json({ error: "room exists" }, 409);

      await kvPut(env, roomName(id), JSON.stringify({
        pub, created: Date.now(), expiresAt: Date.now() + roomTtl * 1000, log: [],
      }));
      return json({ ok: true, ttl: roomTtl });
    }

    // ─── GET /api/rooms/:id — fetch room pubkey (receiver) ───
    const mRoom = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})$/);
    if (method === "GET" && mRoom) {
      const room = await loadRoom(env, mRoom[1]);
      if (!room || (room.expiresAt || 0) < Date.now()) return json({ error: "not found" }, 404);
      return json({ pub: room.pub });
    }

    // ─── POST /api/rooms/:id/signals — append signals (batch) ───
    const mSig = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})\/signals$/);
    if (method === "POST" && mSig) {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const from = body.from;
      if (from !== "s" && from !== "r") return json({ error: "invalid from" }, 400);
      // Accept a single `data` string or a `batch` array — ICE trickle works
      // best when the client can flush several candidates in one request.
      let items = body.batch != null ? body.batch : [body.data];
      if (!Array.isArray(items) || items.length === 0 || items.length > 20) return json({ error: "invalid batch" }, 400);
      for (const d of items) {
        if (typeof d !== "string" || d.length === 0 || d.length > MAX_SIGNAL_DATA) {
          return json({ error: "invalid payload" }, 400);
        }
      }

      const id = mSig[1];
      // Read-modify-write with one retry on concurrent-append conflict.
      for (let attempt = 0; attempt < 2; attempt++) {
        const room = await loadRoom(env, id);
        if (!room || (room.expiresAt || 0) < Date.now()) return json({ error: "not found" }, 404);
        const start = room.log.length;
        if (start + items.length > MAX_LOG) return json({ error: "too many signals" }, 429);
        for (const d of items) room.log.push({ f: from, d });
        room.expiresAt = Math.max(room.expiresAt || 0, Date.now() + 600 * 1000); // activity extends life (10 min)
        try {
          await kvPut(env, roomName(id), JSON.stringify(room));
          return json({ ok: true, from: start + 1, to: room.log.length });
        } catch (e) {
          if (attempt === 1) return json({ error: "write conflict" }, 409);
        }
      }
      return json({ error: "write conflict" }, 409);
    }

    // ─── GET /api/rooms/:id/signals?from=s|&after=N — poll new signals ───
    if (method === "GET" && mSig) {
      const from = url.searchParams.get("from") || "";
      const after = parseInt(url.searchParams.get("after"), 10) || 0;
      if (from !== "s" && from !== "r") return json({ error: "invalid from" }, 400);
      const room = await loadRoom(env, mSig[1]);
      if (!room || (room.expiresAt || 0) < Date.now()) return json({ error: "not found" }, 404);
      const signals = [];
      for (let n = after; n < room.log.length && signals.length < 80; n++) {
        const sig = room.log[n];
        if (sig.f !== from) signals.push({ n: n + 1, data: sig.d });
      }
      return json({ signals, count: room.log.length });
    }

    // ─── POST /api/rooms/:id/burn — sender destroys the room ───
    const mBurn = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})\/burn$/);
    if (method === "POST" && mBurn) {
      const files = await kvList(env, `room_${mBurn[1]}`);
      for (const f of files) await kvDeleteId(env, f.id);
      return json({ ok: true, removed: files.length });
    }

    // ─── GET /api/health — always passes (monitoring) ───
    if (path === "/api/health") return json({ ok: true });

    // ─── everything else: static frontend (single-file app) ───
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Share");
    return res;
  },

  // cron fallback (when the account-wide slot frees up); primary: lazy sweep
  async scheduled(controller, env, ctx) {
    await sweepExpired(env);
  },
};

// Sweep logic (called lazily, by /api/sweep and the scheduled handler).
async function sweepExpired(env) {
  try {
    const now = Date.now();
    let removed = 0;
    for (const f of await kvList(env, "room_")) {
      let expired = false;
      try {
        const room = JSON.parse(await kvGet(env, f.name));
        expired = !room || (room.expiresAt || 0) < now;
      } catch { expired = true; }
      if (expired) { await kvDeleteId(env, f.id); removed++; }
    }
    console.log(`share sweep: removed ${removed} expired rooms`);
    return removed;
  } catch (e) {
    console.log("share sweep failed:", String(e?.message || e));
    return 0;
  }
}
