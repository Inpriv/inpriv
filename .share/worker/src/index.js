// ── Inpriv Share — signaling relay (Cloudflare Worker + Google Drive) ────────
// Zero-knowledge relay for WebRTC signaling. Rooms are opaque ids; every
// payload after hello is AES-GCM sealed client-side (ECDH P-256), so the
// relay never sees ICE candidates, IPs or SDP. Rooms self-destruct (TTL),
// are single-use, and can be burned by the sender after transfer.
//
// Storage: Google Drive folder "inpriv/.share" (user OAuth):
//   room_<id>.json          → { pub, created, expiresAt }   (room, ~15 min)
//   room_<id>_sig_<n>.json  → { from, data }                (signal, ~10 min)
//   room_<id>_count         → counter for n
// File names carry expiry; the hourly cron sweeps expired rooms/signals.
//
// All state is ephemeral. No logs, no analytics, no IPs stored.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { kvPut, kvGet, kvDelete, kvDeleteId, kvList } from "../../../common/drive.js";

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

// Hourly sweep logic (called by /api/sweep and the scheduled handler).
async function sweepExpired(env) {
  try {
    const now = Date.now();
    let removed = 0;
    for (const f of await kvList(env, "room_")) {
      let expired = false;
      try {
        const d = JSON.parse(await kvGet(env, f.name));
        expired = (d.expiresAt || 0) < now;
      } catch { expired = f.name.endsWith(".json"); } // malformed → only remove json payloads
      if (expired) { await kvDeleteId(env, f.id); removed++; }
    }
    console.log(`share sweep: removed ${removed} expired files`);
    return removed;
  } catch (e) {
    console.log("share sweep failed:", String(e?.message || e));
    return 0;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Lazy sweep: ~4% of requests clean expired rooms/signals (no cron slots
    // left on the Free plan; expected once per ~25 requests).
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

    // ─── POST /api/sweep — internal, called by admin cron with shared secret ───
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

      const existing = await kvGet(env, `room_${id}.json`);
      if (existing != null) {
        // expired file not yet swept? treat as gone
        try {
          const r = JSON.parse(existing);
          if ((r.expiresAt || 0) > Date.now()) return json({ error: "room exists" }, 409);
        } catch { return json({ error: "room exists" }, 409); }
      }

      await kvPut(env, `room_${id}.json`, JSON.stringify({ pub, created: Date.now(), expiresAt: Date.now() + roomTtl * 1000 }));
      return json({ ok: true, ttl: roomTtl });
    }

    // ─── GET /api/rooms/:id — fetch room pubkey (receiver) ───
    const mRoom = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})$/);
    if (method === "GET" && mRoom) {
      const raw = await kvGet(env, `room_${mRoom[1]}.json`);
      if (raw == null) return json({ error: "not found" }, 404);
      let room;
      try { room = JSON.parse(raw); } catch { return json({ error: "not found" }, 404); }
      if ((room.expiresAt || 0) < Date.now()) { await kvDelete(env, `room_${mRoom[1]}.json`); return json({ error: "not found" }, 404); }
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
      const roomRaw = await kvGet(env, `room_${id}.json`);
      if (roomRaw == null) return json({ error: "not found" }, 404);

      const cntRaw = await kvGet(env, `room_${id}_count`);
      const n = (parseInt(cntRaw, 10) || 0) + 1;
      if (n > MAX_SIGNALS) return json({ error: "too many signals" }, 429);
      await kvPut(env, `room_${id}_sig_${n}.json`, JSON.stringify({ from, data, expiresAt: Date.now() + SIGNAL_TTL * 1000 }));
      await kvPut(env, `room_${id}_count`, String(n));
      return json({ ok: true, n });
    }

    // ─── GET /api/rooms/:id/signals?from=s|&after=N — poll signals ───
    if (method === "GET" && mSig) {
      const id = mSig[1];
      const from = url.searchParams.get("from") || "";
      const after = parseInt(url.searchParams.get("after"), 10) || 0;
      if (from !== "s" && from !== "r") return json({ error: "invalid from" }, 400);
      const roomRaw = await kvGet(env, `room_${id}.json`);
      if (roomRaw == null) return json({ error: "not found" }, 404);

      const cntRaw = await kvGet(env, `room_${id}_count`);
      const count = Math.min(parseInt(cntRaw, 10) || 0, MAX_SIGNALS);
      const signals = [];
      for (let n = after + 1; n <= count && signals.length < 40; n++) {
        const raw = await kvGet(env, `room_${id}_sig_${n}.json`);
        if (raw != null) {
          try {
            const sig = JSON.parse(raw);
            if (sig.from !== from) signals.push({ n, data: sig.data });
          } catch {}
        }
      }
      return json({ signals, count });
    }

    // ─── POST /api/rooms/:id/burn — sender destroys the room ───
    const mBurn = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,64})\/burn$/);
    if (method === "POST" && mBurn) {
      const id = mBurn[1];
      const files = await kvList(env, `room_${id}`);
      for (const f of files) await kvDeleteId(env, f.id);
      return json({ ok: true, removed: files.length });
    }

    // ─── GET /api/health — always passes (monitoring) ───
    if (path === "/api/health") return json({ ok: true });

    // ─── everything else: static frontend (single-file app) ───
    return env.ASSETS.fetch(request);
  },

  // cron kept as fallback (when the account-wide slot frees up); the primary
  // trigger is admin's cron → POST /api/sweep
  async scheduled(controller, env, ctx) {
    await sweepExpired(env);
  },
};
