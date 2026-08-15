import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("hash");
    if (gate.locked) return maintenancePage("Inpriv Hash", gate.message);
    return env.ASSETS.fetch(request);
  },
};
