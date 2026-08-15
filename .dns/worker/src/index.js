import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("dns");
    if (gate.locked) return maintenancePage("Inpriv DNS", gate.message);
    return env.ASSETS.fetch(request);
  },
};
