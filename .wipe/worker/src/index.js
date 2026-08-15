import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("wipe");
    if (gate.locked) return maintenancePage("Inpriv Wipe", gate.message);
    return env.ASSETS.fetch(request);
  },
};
