import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("trace");
    if (gate.locked) return maintenancePage("Inpriv Trace", gate.message);
    return env.ASSETS.fetch(request);
  },
};
