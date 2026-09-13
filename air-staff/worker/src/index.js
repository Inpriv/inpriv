// ── Inpriv Air — 802.11 resilience auditor (Cloudflare Worker) ──────────────
import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const gate = await maintenanceGate("air");
    if (gate.locked && path !== "/api/health") {
      return maintenancePage("Inpriv Air", gate.message);
    }

    if (path === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Air");
    return res;
  },
};
