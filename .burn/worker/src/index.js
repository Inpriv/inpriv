// Inpriv Burn — Cloudflare Worker
// Zero-knowledge ephemeral notes: server stores ONLY encrypted blobs.
// Key never leaves the client (URL fragment). KV with TTL + burn-after-read.
// Copyright (c) 2026 Inpriv Labs — MIT License

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_CIPHERTEXT = 200000; // chars (~150 KB)
const MIN_TTL = 60;             // 1 minute
const MAX_TTL = 30 * 24 * 3600; // 30 days

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const gate = await maintenanceGate("burn");
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage("Inpriv Burn", gate.message);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

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
      const value = JSON.stringify({
        c: ciphertext,
        b: !!burnAfterRead,
        t: Date.now(),
      });

      try {
        await env.BURN_KV.put(`note:${id}`, value, { expirationTtl: ttl });
        return json({ ok: true, ttl });
      } catch (e) {
        return json({ error: "storage failure" }, 500);
      }
    }

    // ─── GET / DELETE /api/notes/:id ───
    const m = path.match(/^\/api\/notes\/([A-Za-z0-9_-]{16,64})$/);
    if (m) {
      const id = m[1];
      const key = `note:${id}`;

      if (method === "GET") {
        const raw = await env.BURN_KV.get(key);
        if (!raw) return json({ error: "not found" }, 404);
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return json({ error: "corrupt" }, 500);
        }
        // Burn-after-read: destroy after first successful read
        if (data.b) {
          await env.BURN_KV.delete(key).catch(() => {});
        }
        return json({
          ciphertext: data.c,
          burnAfterRead: !!data.b,
          createdAt: data.t,
        });
      }

      if (method === "DELETE") {
        await env.BURN_KV.delete(key).catch(() => {});
        return json({ ok: true });
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
};
