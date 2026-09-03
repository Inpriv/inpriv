import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("keyring");
    if (gate.locked) return maintenancePage("Inpriv Keyring", gate.message);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Keyring");
    return res;
  },
};
