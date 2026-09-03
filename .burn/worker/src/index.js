// Inpriv Burn — Cloudflare Worker
// Zero-knowledge ephemeral notes: server stores ONLY encrypted blobs.
// Key never leaves the client (URL fragment). Notes live as files on Google
// Drive (folder "inpriv/.burn"); TTL + burn-after-read enforced server-side.
// Copyright (c) 2026 Inpriv Labs — MIT License

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";
import { kvPut, kvGet, kvGetId, kvDelete, kvDeleteId, kvList } from "../../../common/drive.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_CIPHERTEXT = 200000; // chars (~150 KB)
const MIN_TTL = 60;             // 1 minute
const MAX_TTL = 30 * 24 * 3600; // 30 days

const nameFor = (id) => `note_${id}`;

// Parse the Drive file name into { id, expiresAt } — null when malformed.
function parseName(name) {
  const m = name.match(/^note_([A-Za-z0-9_-]{16,64})_(\d+)$/);
  if (!m) return null;
  return { id: m[1], expiresAt: Number(m[2]) };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

// Hourly sweep logic (shared by /api/sweep and the scheduled handler).
async function sweepExpired(env) {
  try {
    const now = Date.now();
    const files = await kvList(env, "note_");
    let removed = 0;
    for (const f of files) {
      const p = parseName(f.name);
      if (p && p.expiresAt < now) {
        await kvDeleteId(env, f.id);
        removed++;
      }
    }
    console.log(`burn sweep: removed ${removed}/${files.length} expired notes`);
    return removed;
  } catch (e) {
    console.log("burn sweep failed:", String(e?.message || e));
    return 0;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ─── POST /api/sweep — internal, called by admin cron with shared secret ───
    if (method === "POST" && path === "/api/sweep") {
      const h = request.headers.get("X-Sweep-Secret") || "";
      if (!env.SWEEP_SECRET || h !== env.SWEEP_SECRET) return json({ error: "unauthorized" }, 401);
      const removed = await sweepExpired(env);
      return json({ ok: true, removed });
    }

    // Lazy sweep: no cron slots left on the Free plan, so ~4% of requests
    // clean expired files instead (expected once per ~25 requests).
    if (!env.SWEEP_SECRET || Math.random() < 0.04) {
      // ctx.waitUntil keeps the response fast while the sweep finishes
      (typeof ctx !== "undefined" && ctx?.waitUntil ? ctx.waitUntil(sweepExpired(env)) : Promise.resolve().then(() => sweepExpired(env)).catch(() => {}));
    }

    const gate = await maintenanceGate("burn");
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage("Inpriv Burn", gate.message);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ─── GET /api/health — always passes (monitoring) ───
    if (method === "GET" && path === "/api/health") return json({ ok: true, service: "burn" });

    // ─── POST /api/notes — store an encrypted blob ───
    if (method === "POST" && path === "/api/notes") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad request" }, 400);
      }
      const { id, ciphertext, ttlSeconds, burnAfterRead } = body || {};

      if (typeof id !== "string" || !ID_RE.test(id)) {
        return json({ error: "invalid id" }, 400);
      }
      if (typeof ciphertext !== "string" || ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT) {
        return json({ error: "invalid payload" }, 400);
      }

      const ttl = Math.min(Math.max(parseInt(ttlSeconds, 10) || 86400, MIN_TTL), MAX_TTL);
      const expiresAt = Date.now() + ttl * 1000;
      // TTL lives in the file NAME (cheap cron cleanup — no metadata reads).
      const name = `${nameFor(id)}_${expiresAt}`;
      const value = JSON.stringify({
        c: ciphertext,
        b: !!burnAfterRead,
        t: Date.now(),
      });

      try {
        await kvPut(env, name, value);
        return json({ ok: true, ttl });
      } catch (e) {
        return json({ error: "storage failure" }, 500);
      }
    }

    // ─── GET / DELETE /api/notes/:id ───
    const m = path.match(/^\/api\/notes\/([A-Za-z0-9_-]{16,64})$/);
    if (m) {
      const id = m[1];

      if (method === "GET") {
        // Edge-cache plain notes for 60 s (immutable until expiry) — repeat
        // opens of the same link skip Drive entirely. Burn-after-read notes
        // bypass the cache (one-shot semantics).
        const noEdgeCache = request.headers.get("X-No-Edge-Cache") === "1";
        const cache = caches.default;
        const ck = new Request(`https://cache.local/notes/${id}`, request);
        let res = noEdgeCache ? null : await cache.match(ck);
        if (!res) {
          const files = await kvList(env, `${nameFor(id)}_`);
          const fresh = files.find((f) => (parseName(f.name)?.expiresAt ?? 0) > Date.now());
          const stale = files.filter((f) => f !== fresh);
          // lazy cleanup of expired duplicates / expired read
          if (stale.length) for (const f of stale) kvDeleteId(env, f.id);

          if (!fresh) return json({ error: "not found" }, 404);
          const raw = await kvGetId(env, fresh.id); // reuse id from kvList — no second lookup
          if (raw == null) return json({ error: "not found" }, 404);
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return json({ error: "corrupt" }, 500);
          }
          const body = JSON.stringify({
            ciphertext: data.c,
            burnAfterRead: !!data.b,
            createdAt: data.t,
          });
          res = new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
          });
          if (!data.b) {
            // clone into edge cache; BAR responses are never cached
            const cc = res.clone();
            cc.headers.set("Cache-Control", "public, max-age=60");
            await cache.put(ck, cc);
          }
          // Burn-after-read: destroy after first successful read
          if (data.b) {
            await kvDelete(env, fresh.name);
          }
          return res;
        }
        return res;
      }

      if (method === "DELETE") {
        const files = await kvList(env, `${nameFor(id)}_`);
        for (const f of files) await kvDeleteId(env, f.id);
        // drop the edge-cached GET response, if any
        try { await caches.default.delete(new Request(`https://cache.local/notes/${id}`, request)); } catch {}
        return json({ ok: true });
      }
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) return notFound(request, "Inpriv Burn");
      return res;
    }

    return json({ error: "not found" }, 404);
  },

  // cron kept as fallback (when the account-wide slot frees up); the primary
  // trigger is admin's cron → POST /api/sweep
  async scheduled(controller, env, ctx) {
    await sweepExpired(env);
  },
};
