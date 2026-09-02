// ── Inpriv Status — service health monitor ──────────────────────────────────
// status.inpriv.xyz — probes every Inpriv service from the edge and exposes
// read-only JSON: GET /api/status (live snapshot) and GET /api/history
// (7-day uptime buckets). Poll results are aggregated on Google Drive
// (folder "inpriv/.status"): daily files, one record per service per day
// (no IPs, no user data, nothing personal).
//
// Drive layout (STATUS folder):
//   day_<YYYY-MM-DD>.json → { landing:{s:"up",ms:42,t:...}, ... }  (swept after 8 days)
//   snap.json             → latest full snapshot (~1 h, checked per request)
//
// Kill-switch: like every suite worker, honors the admin maintenance gate
// (service id "status"). /api/health always passes for monitoring.

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { kvPut, kvGet, kvDeleteId, kvList } from "../../../common/drive.js";

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

// Probe with caching: a fresh snapshot at most once per 60 s.
async function getStatus(env) {
  try {
    const raw = await kvGet(env, "snap.json");
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap && Date.now() - snap.t < 60000) return snap;
    }
  } catch (e) { /* fall through to live probe */ }

  const results = await Promise.all(
    SERVICES.map(async (svc) => [svc.id, await probeOne(svc.url)])
  );
  const services = {};
  for (const [id, r] of results) services[id] = r;

  const snap = { checkedAt: new Date().toISOString(), today: todayKeyUTC(), t: Date.now(), services };
  try {
    await kvPut(env, "snap.json", JSON.stringify(snap));
  } catch (e) { /* non-fatal */ }
  return snap;
}

// Merge the live probe into today's daily record (persist for history).
async function recordToday(env, snap) {
  const name = "day_" + snap.today + ".json";
  try {
    const raw = await kvGet(env, name);
    let prev = {};
    try { prev = raw ? JSON.parse(raw) : {}; } catch { prev = {}; }
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
    await kvPut(env, name, JSON.stringify(prev));
  } catch (e) { /* non-fatal */ }
}

async function getHistory(env) {
  const out = { days: HISTORY_DAYS, today: todayKeyUTC(), services: {} };
  if (!env.DRIVE_OAUTH) return out;

  const keys = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    keys.push(d);
  }

  const rows = await Promise.all(
    keys.map(async (d) => {
      try {
        const raw = await kvGet(env, "day_" + d + ".json");
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

// Daily sweep logic (called by /api/sweep and the scheduled handler).
async function sweepOldDays(env) {
  try {
    const cutoff = Date.now() - 8 * 24 * 3600 * 1000;
    let removed = 0;
    for (const f of await kvList(env, "day_")) {
      const m = f.name.match(/^day_(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      if (new Date(m[1] + "T00:00:00Z").getTime() < cutoff) {
        await kvDeleteId(env, f.id);
        removed++;
      }
    }
    console.log(`status sweep: removed ${removed} old day files`);
    return removed;
  } catch (e) {
    console.log("status sweep failed:", String(e?.message || e));
    return 0;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Lazy sweep: ~4% of requests drop day_ files older than 8 days (no cron
    // slots left on the Free plan). Status gets regular traffic anyway.
    if (Math.random() < 0.04 && ctx?.waitUntil) {
      ctx.waitUntil(sweepOldDays(env).catch(() => {}));
    }

    const gate = await maintenanceGate("status");
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage("Inpriv Status", gate.message);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ─── POST /api/sweep — internal, called by admin cron with shared secret ───
    if (method === "POST" && path === "/api/sweep") {
      const h = request.headers.get("X-Sweep-Secret") || "";
      if (!env.SWEEP_SECRET || h !== env.SWEEP_SECRET) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, removed: await sweepOldDays(env) });
    }

    if (method === "GET" && path === "/api/health") {
      return json({ ok: true });
    }

    if (method === "GET" && path === "/api/status") {
      const snap = await getStatus(env);
      if (env.DRIVE_OAUTH) await recordToday(env, snap);
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

  // cron kept as fallback (when the account-wide slot frees up); the primary
  // trigger is admin's cron → POST /api/sweep
  async scheduled(controller, env, ctx) {
    await sweepOldDays(env);
  },
};
