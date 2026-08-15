import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("compress");
    if (gate.locked) return maintenancePage("Inpriv Compress", gate.message);
    return env.ASSETS.fetch(request);
  },
};
