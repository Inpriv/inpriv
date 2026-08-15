import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("keyring");
    if (gate.locked) return maintenancePage("Inpriv Keyring", gate.message);
    return env.ASSETS.fetch(request);
  },
};
