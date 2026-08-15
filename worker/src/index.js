// Inpriv landing — static assets worker + maintenance gate.
// Serves index.html, icon.png, /assets/* from the ASSETS binding.
// Routes:
//   /            → landing HTML
//   /index.html  → 307 → /
//   /robots.txt  → robots
// Everything else falls through to assets (icon.png, assets/icons/*.svg, …).
// Every request passes the admin kill-switch (global or "landing" service).
import { maintenanceGate, maintenancePage } from "../../common/gate.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const gate = await maintenanceGate("landing");
    if (gate.locked) return maintenancePage("Inpriv", gate.message);

    if (path === "/index.html") {
      return new Response(null, { status: 307, headers: { Location: "/" } });
    }

    // Assets binding serves /, /icon.png, /assets/…, /robots.txt (if present).
    return env.ASSETS.fetch(request);
  },
};
