// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Status — status.inpriv.xyz
//
// Checks every public Inpriv site every 5 minutes and shows the history.
// The checks run in Cloudflare's network: Temp's cron (every 5 minutes, see
// .temp/worker) calls Probe.run() over a service binding, because the free
// plan has no cron slot left for this Worker.
//
// A check: GET the site's health URL (8 s timeout) and, for sites with a
// database, a read-only "SELECT 1". A failed check is retried once after 2 s
// before it counts as down. Over 1.5 s is slow. A site paused from
// admin.inpriv.xyz counts as maintenance, which doesn't count against uptime.
//
// Routes:
//   GET /                      the page
//   GET /api/status?range=24h  services, history buckets and incidents
//                              (range: 24h | 7d | 30d | 90d)
//   GET /api/health
//
// Nothing about visitors is stored or logged.
// ─────────────────────────────────────────────────────────────────────────────

import { WorkerEntrypoint } from "cloudflare:workers";
import { notFound } from "../../../common/errors.js";
import { canonicalRedirect } from "../../../common/canonical.js";
import { pageResponse, apiHeaders } from "../../../common/security.js";

// gate = the service id the admin kill-switches use (common/gate.js)
const SERVICES = [
  { id: "site", gate: "landing", name: "Website", host: "inpriv.xyz", probe: "https://inpriv.xyz/" },
  { id: "mail", gate: "mail", name: "Mail", host: "mail.inpriv.xyz", probe: "https://mail.inpriv.xyz/api/v1/health", db: "MAIL_DB" },
  { id: "temp", gate: "temp", name: "Temp", host: "temp.inpriv.xyz", probe: "https://temp.inpriv.xyz/api/health", db: "TEMP_DB" },
  { id: "id", gate: "account", name: "Inpriv ID", host: "id.inpriv.xyz", probe: "https://id.inpriv.xyz/api/health", db: "ID_DB" },
  { id: "loopwright", name: "loopwright", host: "lw.inpriv.xyz", probe: "https://lw.inpriv.xyz/healthz" },
];
const STATE_URL = "https://admin.inpriv.xyz/public/state";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TICK_MS = 5 * MIN;
const TIMEOUT_MS = 8_000;
const RETRY_AFTER_MS = 2_000;
const SLOW_MS = 1_500;
const KEEP_CHECKS_MS = 49 * HOUR;
const KEEP_HOURLY_MS = 92 * DAY;

// span shown, size of one bar, and where the numbers come from
const RANGES = {
  "24h": { span: DAY, bucket: 30 * MIN, raw: true },
  "7d": { span: 7 * DAY, bucket: 4 * HOUR },
  "30d": { span: 30 * DAY, bucket: DAY },
  "90d": { span: 90 * DAY, bucket: 2 * DAY },
};
const API_CACHE_S = 30;

export default {
  async fetch(request, env, ctx) {
    const moved = canonicalRedirect(request);
    if (moved) return moved;
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return apiHeaders(json({ ok: true, service: "inpriv-status", time: new Date().toISOString() }));
    }
    if (path === "/api/status") {
      if (request.method !== "GET" && request.method !== "HEAD") return apiHeaders(json({ error: "Method not allowed" }, 405));
      try {
        return apiHeaders(await statusResponse(env, ctx, url.searchParams.get("range")));
      } catch (err) {
        console.error("status failed", err && err.message);
        return apiHeaders(json({ error: "Status is unavailable right now" }, 500));
      }
    }
    if (path.startsWith("/api/")) return apiHeaders(json({ error: "Not found" }, 404));
    if (path === "/index.html") return new Response(null, { status: 307, headers: { Location: "/" } });

    // The status page is never behind the maintenance gate: it's where people
    // look when something is paused.
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Status");
    return pageResponse(request, res);
  },

  // Production has no cron trigger here (Temp calls Probe.run); this lets
  // `wrangler dev --test-scheduled` run a check locally.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, event.scheduledTime));
  },
};

// Called by Temp's cron: env.STATUS.run(event.scheduledTime)
export class Probe extends WorkerEntrypoint {
  async run(at) {
    return runChecks(this.env, Number(at) || Date.now());
  }
}

// ── checks ───────────────────────────────────────────────────────────────────

async function runChecks(env, scheduledTime) {
  const at = Math.floor(scheduledTime / TICK_MS) * TICK_MS;
  // a tick runs once, even if the cron fires twice
  if (await env.DB.prepare("SELECT 1 FROM checks WHERE at = ? LIMIT 1").bind(at).first()) return { at, skipped: true };
  const gate = await adminState();
  const results = await Promise.all(SERVICES.map((svc) => checkService(env, svc, gate)));

  const open = await env.DB.prepare("SELECT id, service, kind FROM incidents WHERE ended IS NULL").all();
  const openBy = new Map((open.results ?? []).map((r) => [r.service, r]));
  const hour = Math.floor(at / HOUR);
  const stmts = [];

  results.forEach((r, i) => {
    const svc = SERVICES[i];
    const timed = r.state === "up" || r.state === "slow";
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO checks (service, at, state, ms, code) VALUES (?, ?, ?, ?, ?)")
        .bind(svc.id, at, r.state, timed ? r.ms : null, r.code),
      env.DB.prepare(
        `INSERT INTO hourly (service, hour, n, up, slow, down, maint, ms_sum, ms_n, ms_max)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service, hour) DO UPDATE SET
           n = n + 1, up = up + excluded.up, slow = slow + excluded.slow,
           down = down + excluded.down, maint = maint + excluded.maint,
           ms_sum = ms_sum + excluded.ms_sum, ms_n = ms_n + excluded.ms_n,
           ms_max = max(ms_max, excluded.ms_max)`
      ).bind(
        svc.id, hour,
        +(r.state === "up"), +(r.state === "slow"), +(r.state === "down"), +(r.state === "maint"),
        timed ? r.ms : 0, +timed, timed ? r.ms : 0
      ),
    );

    // incidents: one open row per site while it's down or paused
    const cur = openBy.get(svc.id);
    const kind = r.state === "down" || r.state === "maint" ? r.state : null;
    if (cur && cur.kind !== kind) {
      stmts.push(env.DB.prepare("UPDATE incidents SET ended = ? WHERE id = ?").bind(at, cur.id));
    }
    if (kind && cur && cur.kind === kind) {
      stmts.push(env.DB.prepare("UPDATE incidents SET last = ?, checks = checks + 1 WHERE id = ? AND last < ?").bind(at, cur.id, at));
    } else if (kind) {
      stmts.push(
        env.DB.prepare("INSERT INTO incidents (service, kind, started, last, checks, note) VALUES (?, ?, ?, ?, 1, ?)")
          .bind(svc.id, kind, at, at, r.note || null)
      );
    }
  });

  // retention, once an hour
  if (at % HOUR === 0) {
    stmts.push(
      env.DB.prepare("DELETE FROM checks WHERE at < ?").bind(at - KEEP_CHECKS_MS),
      env.DB.prepare("DELETE FROM hourly WHERE hour < ?").bind(Math.floor((at - KEEP_HOURLY_MS) / HOUR)),
      env.DB.prepare("DELETE FROM incidents WHERE ended IS NOT NULL AND ended < ?").bind(at - KEEP_HOURLY_MS),
    );
  }
  await env.DB.batch(stmts);
  return { at, results: results.map((r, i) => ({ service: SERVICES[i].id, state: r.state, ms: r.ms })) };
}

async function checkService(env, svc, gate) {
  if (svc.gate && gate.paused(svc.gate)) return { state: "maint", ms: null, code: 0, note: gate.message(svc.gate) };
  let r = await checkOnce(env, svc);
  if (!r.ok) {
    await new Promise((done) => setTimeout(done, RETRY_AFTER_MS));
    r = await checkOnce(env, svc);
  }
  if (!r.ok) return { state: "down", ms: null, code: r.code };
  return { state: r.ms > SLOW_MS ? "slow" : "up", ms: r.ms, code: r.code };
}

async function checkOnce(env, svc) {
  const t0 = Date.now();
  let code = 0;
  try {
    const res = await fetch(svc.probe, {
      headers: { "User-Agent": "inpriv-status" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    code = res.status;
    await res.body?.cancel();
    if (code !== 200) return { ok: false, code };
    if (svc.db) await env[svc.db].prepare("SELECT 1").first();
    return { ok: true, code, ms: Date.now() - t0 };
  } catch {
    return { ok: false, code };
  }
}

// The kill-switch state from admin. If admin can't be reached, nothing
// counts as paused (the sites fail open the same way).
let stateCache = { data: null, until: 0 };

async function adminState() {
  const now = Date.now();
  let st = stateCache.until > now ? stateCache.data : null;
  if (!st) {
    try {
      const res = await fetch(STATE_URL, { headers: { "User-Agent": "inpriv-status" }, signal: AbortSignal.timeout(4_000) });
      st = res.ok ? await res.json() : {};
    } catch {
      st = {};
    }
    stateCache = { data: st, until: now + 15_000 };
  }
  const global = st.global && st.global.locked ? st.global : null;
  const svc = (id) => (st.services && st.services[id]) || {};
  return {
    paused: (id) => !!global || !!svc(id).locked,
    message: (id) => (global ? global.message : svc(id).message) || "",
    info: st.info && st.info.active && st.info.message ? String(st.info.message) : null,
  };
}

// ── API ──────────────────────────────────────────────────────────────────────

async function statusResponse(env, ctx, rangeParam) {
  const range = RANGES[rangeParam] ? rangeParam : "24h";
  const cache = caches.default;
  const key = new Request(`https://status.cache/api/status?range=${range}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);

  const res = json(await buildStatus(env, range));
  res.headers.set("Cache-Control", `public, max-age=${API_CACHE_S}`);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function buildStatus(env, range) {
  const now = Date.now();
  const cfg = RANGES[range];
  const end = Math.ceil((now + 1) / cfg.bucket) * cfg.bucket;
  const start = end - cfg.span;
  const count = cfg.span / cfg.bucket;

  const blank = () => Array.from({ length: count }, () => ({ n: 0, up: 0, slow: 0, down: 0, maint: 0, ms_sum: 0, ms_n: 0, ms_max: 0 }));
  const buckets = Object.fromEntries(SERVICES.map((s) => [s.id, blank()]));
  const add = (service, t, row) => {
    const b = buckets[service] && buckets[service][Math.floor((t - start) / cfg.bucket)];
    if (!b) return;
    for (const k of ["n", "up", "slow", "down", "maint", "ms_sum", "ms_n"]) b[k] += row[k];
    b.ms_max = Math.max(b.ms_max, row.ms_max);
  };

  const [rows, latest, incidents, gate] = await Promise.all([
    cfg.raw
      ? env.DB.prepare("SELECT service, at, state, ms FROM checks WHERE at >= ?").bind(start).all()
      : env.DB.prepare("SELECT * FROM hourly WHERE hour >= ?").bind(Math.floor(start / HOUR)).all(),
    env.DB.prepare(
      `SELECT c.service, c.at, c.state, c.ms FROM checks c
       JOIN (SELECT service, max(at) AS m FROM checks GROUP BY service) x ON x.service = c.service AND x.m = c.at`
    ).all(),
    env.DB.prepare(
      "SELECT service, kind, started, ended, last, checks, note FROM incidents WHERE ended IS NULL OR ended >= ? ORDER BY started DESC LIMIT 100"
    ).bind(start).all(),
    adminState(),
  ]);

  for (const r of rows.results ?? []) {
    if (cfg.raw) {
      const timed = r.ms != null;
      add(r.service, r.at, {
        n: 1, up: +(r.state === "up"), slow: +(r.state === "slow"), down: +(r.state === "down"), maint: +(r.state === "maint"),
        ms_sum: timed ? r.ms : 0, ms_n: +timed, ms_max: timed ? r.ms : 0,
      });
    } else {
      add(r.service, r.hour * HOUR, r);
    }
  }

  const last = new Map((latest.results ?? []).map((r) => [r.service, r]));
  const services = SERVICES.map((s) => {
    const list = buckets[s.id];
    const sum = list.reduce((a, b) => {
      for (const k of ["n", "up", "slow", "down", "maint", "ms_sum", "ms_n"]) a[k] += b[k];
      a.ms_max = Math.max(a.ms_max, b.ms_max);
      return a;
    }, { n: 0, up: 0, slow: 0, down: 0, maint: 0, ms_sum: 0, ms_n: 0, ms_max: 0 });
    const counted = sum.n - sum.maint;
    const l = last.get(s.id);
    return {
      id: s.id,
      name: s.name,
      host: s.host,
      state: l ? l.state : null,
      ms: l ? l.ms : null,
      checked: l ? l.at : null,
      uptime: counted > 0 ? (sum.up + sum.slow) / counted : null,
      avg: sum.ms_n ? Math.round(sum.ms_sum / sum.ms_n) : null,
      max: sum.ms_n ? sum.ms_max : null,
      checks: sum.n,
      // [checks, up, slow, down, maint, ms total, timed checks], for filtered sums on the page
      totals: [sum.n, sum.up, sum.slow, sum.down, sum.maint, sum.ms_sum, sum.ms_n],
      // [checks, up, slow, down, maint, average ms or null, max ms or null]
      buckets: list.map((b) => [b.n, b.up, b.slow, b.down, b.maint, b.ms_n ? Math.round(b.ms_sum / b.ms_n) : null, b.ms_n ? b.ms_max : null]),
    };
  });

  return {
    now,
    range,
    start,
    bucket: cfg.bucket,
    interval: TICK_MS,
    slow_ms: SLOW_MS,
    checked: Math.max(0, ...services.map((s) => s.checked || 0)) || null,
    notice: gate.info,
    services,
    incidents: (incidents.results ?? []).map((r) => ({
      service: r.service, kind: r.kind, started: r.started, ended: r.ended, last: r.last, checks: r.checks, note: r.note || null,
    })),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
