import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("brute");
    if (gate.locked) return maintenancePage("Inpriv Brute", gate.message);
    return env.ASSETS.fetch(request);
  },
};
