// stego.inpriv.xyz moved into Inpriv Image. Permanent redirect keeps bookmarks working.
const TARGET = "https://image.inpriv.xyz/";
const MODE = "stego";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, redirect: TARGET + "#" + MODE }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    // Installed copies run a cache-first service worker on this origin; serve a
    // replacement that clears its caches and unregisters so the redirect is reached.
    if (url.pathname === "/sw.js") {
      return new Response(
        "self.addEventListener('install', () => self.skipWaiting());\n" +
        "self.addEventListener('activate', (e) => e.waitUntil((async () => {\n" +
        "  for (const k of await caches.keys()) await caches.delete(k);\n" +
        "  await self.registration.unregister();\n" +
        "  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);\n" +
        "})()));\n",
        { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }
    return new Response(null, {
      status: 301,
      headers: { Location: TARGET + "#" + MODE, "Cache-Control": "public, max-age=3600" },
    });
  },
};
