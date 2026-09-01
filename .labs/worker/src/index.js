// ── Inpriv Labs — static experiment bench (Cloudflare Worker) ────────────────
import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

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

    return env.ASSETS.fetch(request);
  },
};
