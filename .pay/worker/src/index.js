import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("pay");
    if (gate.locked) return maintenancePage("Inpriv Pay", gate.message);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Pay");
    return res;
  },
};
