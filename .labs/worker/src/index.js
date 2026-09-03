// ── Inpriv Labs — static experiment bench (Cloudflare Worker) ────────────────
import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const gate = await maintenanceGate("labs");
    if (gate.locked && path !== "/api/health") {
      return maintenancePage("Inpriv Labs", gate.message);
    }

    if (path === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // Device Specs experiment — stateless IP reveal for the visitor's own
    // address. Nothing is logged, nothing is stored; the edge inherently
    // sees the connecting IP but no record is written anywhere.
    if (path === "/api/ip") {
      const cf = request.cf || {};
      const payload = {
        ip: request.headers.get("cf-connecting-ip") || "unknown",
        country: cf.country || null,
        colo: cf.colo || null,
      };
      return new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex",
        },
      });
    }

    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Labs");
    return res;
  },
};
