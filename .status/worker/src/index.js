// ── Inpriv Status — service health monitor ──────────────────────────────────
// status.inpriv.xyz — probes every Inpriv service from the edge and exposes
// read-only JSON: GET /api/status (live snapshot) and GET /api/history
// (7-day uptime buckets). Poll results are aggregated in KV: daily keys,
// one record per service per day (no IPs, no user data, nothing personal).
//
// KV layout (STATUS_KV):
//   day:<YYYY-MM-DD>  → { landing:{s:"up",ms:42,t:...}, ... }  (TTL 8 days)
//   snap              → latest full snapshot (TTL 1 h)
//
// Kill-switch: like every suite worker, honors the admin maintenance gate
// (service id "status"). /api/health always passes for monitoring.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

const HISTORY_DAYS = 7;
const PROBE_TIMEOUT_MS = 8000;

// id = admin SERVICES id (kill-switch + paused display), url = probe target.
const SERVICES = [
  { id: "landing",  url: "https://inpriv.xyz" },
  { id: "account",  url: "https://id.inpriv.xyz" },
  { id: "mail",     url: "https://mail.inpriv.xyz" },
  { id: "temp",     url: "https://temp.inpriv.xyz" },
  { id: "fake",     url: "https://fake.inpriv.xyz" },
  { id: "host",     url: "https://host.inpriv.xyz" },
  { id: "share",    url: "https://share.inpriv.xyz" },
  { id: "burn",     url: "https://burn.inpriv.xyz" },
  { id: "trace",    url: "https://trace.inpriv.xyz" },
  { id: "censor",   url: "https://censor.inpriv.xyz" },
  { id: "stego",    url: "https://stego.inpriv.xyz" },
  { id: "qr",       url: "https://qr.inpriv.xyz" },
  { id: "totp",     url: "https://totp.inpriv.xyz" },
  { id: "keyring",  url: "https://keyring.inpriv.xyz" },
  { id: "brute",    url: "https://brute.inpriv.xyz" },
  { id: "hash",     url: "https://hash.inpriv.xyz" },
  { id: "compress", url: "https://compress.inpriv.xyz" },
  { id: "wipe",     url: "https://wipe.inpriv.xyz" },
  { id: "pay",      url: "https://pay.inpriv.xyz" },
  { id: "labs",     url: "https://labs.inpriv.xyz" },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function probeOne(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "User-Agent": "inpriv-status/1.0", "Accept": "text/html,*/*" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const ms = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 400;
    return { s: ok ? "up" : "down", ms, code: res.status, t: t0 };
  } catch (e) {
    return { s: "down", ms: Date.now() - t0, code: 0, t: t0 };
  }
}

// Probe with edge caching: a fresh snapshot at most once per 60 s.
async function getStatus(env) {
  if (env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get("snap");
      if (cached) {
        const snap = JSON.parse(cached);
        if (snap && Date.now() - snap.t < 60000) return snap;
      }
    } catch (e) { /* fall through to live probe */ }
  }

  const results = await Promise.all(
    SERVICES.map(async (svc) => [svc.id, await probeOne(svc.url)])
  );
  const services = {};
  for (const [id, r] of results) services[id] = r;

  const snap = { checkedAt: new Date().toISOString(), today: todayKeyUTC(), services };
  if (env.STATUS_KV) {
    try {
      await env.STATUS_KV.put("snap", JSON.stringify(snap), { expirationTtl: 3600 });
    } catch (e) { /* non-fatal */ }
  }
  return snap;
}

// Merge the live probe into today's daily record (persist for history).
async function recordToday(env, snap) {
  if (!env.STATUS_KV) return;
  const key = "day:" + snap.today;
  try {
    const raw = await env.STATUS_KV.get(key);
    const prev = raw ? JSON.parse(raw) : {};
    for (const svc of SERVICES) {
      const live = snap.services[svc.id];
      if (!live) continue;
      const cur = prev[svc.id];
      // Record today's worst observed state so a single blip is visible,
      // but keep the latest latency and never let a stale snapshot
      // (recorded before this one) overwrite fresher data.
      if (!cur || cur.t < live.t) {
        prev[svc.id] = {
          s: live.s,
          ms: live.ms,
          t: live.t,
          worst: cur && cur.worst === "down" ? "down" : live.s,
        };
      }
    }
    await env.STATUS_KV.put(key, JSON.stringify(prev), { expirationTtl: 8 * 24 * 3600 });
  } catch (e) { /* non-fatal */ }
}

async function getHistory(env) {
  const out = { days: HISTORY_DAYS, today: todayKeyUTC(), services: {} };
  if (!env.STATUS_KV) return out;

  const keys = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    keys.push(d);
  }

  const rows = await Promise.all(
    keys.map(async (d) => {
      try {
        const raw = await env.STATUS_KV.get("day:" + d);
        return [d, raw ? JSON.parse(raw) : null];
      } catch {
        return [d, null];
      }
    })
  );

  for (const svc of SERVICES) {
    out.services[svc.id] = keys.map((d) => {
      const row = rows.find(([rd]) => rd === d);
      const rec = row && row[1] && row[1][svc.id];
      if (!rec) return { d, s: "nodata", ms: null };
      return { d, s: rec.worst || rec.s, ms: rec.ms };
    });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const gate = await maintenanceGate("status");
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage("Inpriv Status", gate.message);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (method === "GET" && path === "/api/health") {
      return json({ ok: true });
    }

    if (method === "GET" && path === "/api/status") {
      const snap = await getStatus(env);
      if (env.STATUS_KV) await recordToday(env, snap);
      return json(snap);
    }

    if (method === "GET" && path === "/api/history") {
      return json(await getHistory(env));
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
};
