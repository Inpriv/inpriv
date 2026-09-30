import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

// Legacy hosts are served by their own (now redirect-only) workers; this
// worker only serves image.inpriv.xyz.
export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("image");
    if (gate.locked) return maintenancePage("Inpriv Image", gate.message);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Image");
    return res;
  },
};
