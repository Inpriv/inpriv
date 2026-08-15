import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("pay");
    if (gate.locked) return maintenancePage("Inpriv Pay", gate.message);
    return env.ASSETS.fetch(request);
  },
};
