// Inpriv Stego — static asset worker + maintenance gate.
// The tool is 100% client-side; this worker only serves files and never
// touches user data (there is no API by design). The admin kill-switch can
// still take the whole page down.
import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env, ctx) {
    const gate = await maintenanceGate("stego");
    if (gate.locked) return maintenancePage("Inpriv Stego", gate.message);
    return env.ASSETS.fetch(request);
  },
};
