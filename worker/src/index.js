// Inpriv landing — static assets worker + maintenance gate.
// Serves index.html, icon.png, /assets/* from the ASSETS binding.
// Routes:
//   /            → landing HTML
//   /index.html  → 307 → /
//   /robots.txt  → robots
// Everything else falls through to assets (icon.png, assets/icons/*.svg, …).
// Every request passes the admin kill-switch (global or "landing" service).
import { maintenanceGate, maintenancePage } from "../../common/gate.js";
import { notFound } from "../../common/errors.js";
import { canonicalRedirect } from "../../common/canonical.js";
import { pageResponse, apiHeaders } from "../../common/security.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const moved = canonicalRedirect(request);
    if (moved) return moved;

    // Public maintenance state for the notice banner. It has to answer while
    // the site is locked, so it sits above the gate. apiHeaders adds the same
    // headers as every other API response, no-store included: a cached notice
    // would outlive the thing it announces.
    if (path === "/api/maintenance") {
      const gate = await maintenanceGate("landing", env);
      return apiHeaders(new Response(JSON.stringify({ locked: gate.locked, message: gate.message, info: gate.info }), {
        headers: { "content-type": "application/json" },
      }));
    }

    const gate = await maintenanceGate("landing", env);
    if (gate.locked) return maintenancePage("Inpriv", gate.message);

    if (path === "/index.html") {
      return new Response(null, { status: 307, headers: { Location: "/" } });
    }

    // Assets binding serves /, /icon.png, /assets/…, /robots.txt (if present).
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv");
    // the landing page asks id.inpriv.xyz whether you're signed in
    return pageResponse(request, res, { "connect-src": ["https://id.inpriv.xyz"] });
  },
};
