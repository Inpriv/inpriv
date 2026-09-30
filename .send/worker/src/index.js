import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound } from "../../../common/errors.js";

// Inpriv Send: /burn/ (one-time notes) and /share/ (P2P file transfer).
// Each backend stays in its own worker (own storage credentials, secrets and
// kill-switch id); /burn/api/* and /share/api/* are forwarded to them through
// service bindings with the prefix removed.
const BACKENDS = [
  ["/burn/api/", "BURN", "/burn"],
  ["/share/api/", "SHARE", "/share"],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    for (const [prefix, binding, strip] of BACKENDS) {
      if (url.pathname.startsWith(prefix)) {
        const target = new URL(request.url);
        target.pathname = url.pathname.slice(strip.length);
        return env[binding].fetch(new Request(target, request));
      }
    }

    const gate = await maintenanceGate("send");
    if (gate.locked) return maintenancePage("Inpriv Send", gate.message);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return notFound(request, "Inpriv Send");
    return res;
  },
};
