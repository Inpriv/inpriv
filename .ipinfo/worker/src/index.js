import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("ipinfo");
    if (gate.locked) return maintenancePage("Inpriv IP Info", gate.message);
    return env.ASSETS.fetch(request);
  },
};
