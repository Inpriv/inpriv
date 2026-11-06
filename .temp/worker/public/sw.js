// Only public icons and the offline page are stored. App HTML and APIs stay live.
const CACHE = 'inpriv-public-v1';
const ICONS = new Set([
  '/assets/icons/pwa/app-192.png',
  '/assets/icons/pwa/app-512.png',
  '/assets/icons/pwa/maskable-512.png',
]);
const OFFLINE = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, ...ICONS])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('inpriv-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(async () => {
      const offline = await caches.match(OFFLINE, { cacheName: CACHE });
      return offline || new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0c0c0b"><title>Inpriv — Offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0c0b;color:#f2f1ed;font:16px/1.5 system-ui}main{padding:28px;max-width:360px}a{display:inline-block;padding:12px 24px;border-radius:999px;background:#f2f1ed;color:#0c0c0b;text-decoration:none}</style><main><h1>You're offline.</h1><p>Reconnect to use Inpriv.</p><a href="">Try again</a></main></html>`, {
        status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" },
      });
    }));
    return;
  }
  if (!ICONS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(url.pathname);
    if (saved) return saved;
    const fresh = await fetch(event.request);
    if (fresh.ok) await cache.put(url.pathname, fresh.clone());
    return fresh;
  })());
});
