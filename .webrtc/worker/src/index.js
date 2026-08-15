import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("webrtc");
    if (gate.locked) return maintenancePage("Inpriv WebRTC", gate.message);
    return env.ASSETS.fetch(request);
  },
};
