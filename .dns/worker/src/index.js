import { maintenanceGate, maintenancePage } from "../../../common/gate.js";

export default {
  async fetch(request, env) {
    const gate = await maintenanceGate("dns");
    if (gate.locked) return maintenancePage("Inpriv DNS Leak", gate.message);
    const url = new URL(request.url);
    return Response.redirect("https://trace.inpriv.xyz/", 301);
  },
};
