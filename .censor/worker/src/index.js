import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("censor");
    if (gate.locked) return maintenancePage("Inpriv Censor", gate.message);
    return env.ASSETS.fetch(request);
  },
};
