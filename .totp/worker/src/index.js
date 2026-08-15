import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("totp");
    if (gate.locked) return maintenancePage("Inpriv TOTP", gate.message);
    return env.ASSETS.fetch(request);
  },
};
