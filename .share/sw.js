/* Inpriv Share — service worker (PWA offline shell)
   Versioned cache; network-first for navigation (fresh HTML matters),
   cache-first for same-origin statics. Never caches cross-origin. */

const VERSION = "share-v1";
const STATIC_CACHE = `${VERSION}-static`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Precache is intentionally minimal: the app is a single HTML file
    // fetched network-first; icons/manifest go in lazily on first use.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch the signaling API — always live network.
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // Navigations: network-first, fall back to cache (offline shell).
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(STATIC_CACHE);
        cache.put("/", fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match("/")) || (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  // Same-origin statics: cache-first with background refresh.
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      if (hit) {
        fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
        return hit;
      }
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return Response.error();
      }
    })());
  }
  // Cross-origin (fonts): let the browser handle it — never cached here.
});
