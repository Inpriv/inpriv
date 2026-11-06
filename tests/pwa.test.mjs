// Chrome + local HTTP fixtures only. CHROME=/path/to/chrome node --test tests/pwa.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { pageResponse } from '../common/security.js';

const ROOT = resolve(import.meta.dirname, '..');
const folders = { landing: 'worker/public', mail: '.mail/worker/public', temp: '.temp/worker/public' };
const sites = {};
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let browser;
const pause = ms => new Promise(r => setTimeout(r, ms));
before(async () => {
  for (const [name, folder] of Object.entries(folders)) {
    const site = sites[name] = { name, folder, requests: [], user: null };
    site.server = createServer(async (req, res) => {
      const url = new URL(req.url, site.origin);
      site.requests.push(url.pathname);
      if (site.offline) { req.socket.destroy(); return; }
      if (url.pathname.startsWith('/api/')) {
        let status = 200, data = {};
        if (url.pathname === '/api/v1/me') { status = site.user ? 200 : 401; data = site.user || { error: 'fixture: signed out' }; }
        else if (url.pathname === '/api/v1/login') data = { status: 'needs_init', init_ticket: 'fixture-only' };
        else if (url.pathname === '/api/v1/init-keys') {
          let body = ''; for await (const chunk of req) body += chunk;
          const d = JSON.parse(body);
          site.user = { id: 1, username: 'pwatest', email: 'pwatest@inpriv.xyz', public_key: d.public_key, key_id: d.key_id, ...d.envelope, quick_unlock: false, created_at: Date.now() };
          data = { user: site.user };
        } else if (url.pathname === '/api/v1/messages') data = { items: [] };
        else if (url.pathname === '/api/mailbox') { status = req.method === 'POST' ? 201 : 200; data = { address: 'sample-layout-12345@inpriv.xyz', token: 'fixture-only', expires_at: Date.now() + 86400000 }; }
        else if (url.pathname === '/api/private') data = { secret: 'private-fixture-must-not-cache' };
        else data = { messages: [] };
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data));
      }
      if (url.pathname === '/seed.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>Local seed</title>'); }
      const path = resolve(ROOT, folder, url.pathname === '/' ? 'index.html' : '.' + url.pathname);
      if (!path.startsWith(resolve(ROOT, folder) + '/') || !existsSync(path)) { res.writeHead(404); return res.end(); }
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.webmanifest') ? 'application/manifest+json' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      const body = readFileSync(path);
      if (type === 'text/html') {
        const response = await pageResponse(new Request(url), new Response(body, { headers: { 'Content-Type': type } }), name === 'mail' ? { 'script-src': ['https://id.inpriv.xyz'], 'connect-src': ['http:'], '=frame-src': ["'self'"] } : {});
        res.writeHead(response.status, Object.fromEntries(response.headers));
        const html = await response.text();
        if (url.searchParams.has('stream')) {
          const end = html.indexOf('</script>', html.indexOf('<script id="inpriv-pwa">')) + 9;
          res.write(html.slice(0, end));
          return setTimeout(() => res.end(html.slice(end)), 350);
        }
        return res.end(html);
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body);
    });
    await new Promise(r => site.server.listen(0, '127.0.0.1', r));
    site.origin = 'http://127.0.0.1:' + site.server.address().port;
  }
  const executablePath = process.env.CHROME || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set CHROME to a Chrome executable (see tests/README.md).');
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); for (const site of Object.values(sites)) await new Promise(r => site.server.close(r)); });

async function open(site, context = null) {
  const page = await (context || browser).newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on('request', r => r.url().startsWith(site.origin) ? r.continue() : r.abort());
  return page;
}
async function controlled(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

test('Chrome parses distinct standalone manifests with valid app and maskable icons', async () => {
  const identities = new Set();
  for (const site of Object.values(sites)) {
    const page = await open(site);
    try {
      await page.goto(site.origin + '/?home', { waitUntil: 'load' });
      const cdp = await page.createCDPSession();
      const result = await cdp.send('Page.getAppManifest');
      assert.deepEqual(result.errors, []);
      const manifest = JSON.parse(result.data);
      if (site.name === 'mail') {
        assert.equal(manifest.name, 'Inpriv Mail');
        assert.equal(manifest.short_name, 'Inpriv Mail');
        assert.equal(await page.title(), 'Inpriv Mail');
        assert.equal(await page.$eval('meta[name="application-name"]', e => e.content), 'Inpriv Mail');
        assert.equal(await page.$eval('meta[name="apple-mobile-web-app-title"]', e => e.content), 'Inpriv Mail');
      }
      assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.background_color, '#0c0c0b');
      assert.equal(manifest.theme_color, '#0c0c0b');
      assert.equal(manifest.scope, '/'); assert.equal(manifest.start_url, '/');
      identities.add(new URL(manifest.id, site.origin).href);
      for (const size of [192, 512]) assert.ok(manifest.icons.some(i => i.sizes === `${size}x${size}`));
      for (const icon of manifest.icons) {
      const decoded = await page.evaluate(async src => {
        const image = new Image(); image.src = src; await image.decode();
        const c = document.createElement('canvas'); c.width = c.height = image.naturalWidth;
        const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
        return { width: image.naturalWidth, alpha: ctx.getImageData(0, 0, 1, 1).data[3] };
      }, icon.src);
      assert.deepEqual(decoded, { width: parseInt(icon.sizes, 10), alpha: 255 });
      }
      await controlled(page);
      const eligibility = await cdp.send('Page.getInstallabilityErrors');
      assert.deepEqual(eligibility.installabilityErrors, []);
    } finally { await page.close(); }
  }
  assert.equal(identities.size, 3);
});

test('saved and system themes paint correctly before the rest of the document arrives', async () => {
  for (const [saved, system, expected] of [['dark', 'light', 'rgb(12, 12, 11)'], ['light', 'dark', 'rgb(235, 233, 228)'], [null, 'dark', 'rgb(12, 12, 11)'], [null, 'light', 'rgb(235, 233, 228)']]) {
    const ctx = await browser.createBrowserContext(), page = await open(sites.mail, ctx);
    try {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: system }]);
      await page.evaluateOnNewDocument(saved => { if (saved) localStorage.setItem('inpriv_theme', saved); }, saved);
      const loading = page.goto(sites.mail.origin + '/?stream=1', { waitUntil: 'load' });
      await page.waitForFunction(() => !!document.documentElement.style.backgroundColor);
      assert.equal(await page.$eval('html', e => getComputedStyle(e).backgroundColor), expected);
      assert.equal(await page.$('#inpriv-ui'), null, 'the startup color is applied before the main CSS arrives');
      await loading;
      assert.equal(await page.$eval('html', e => getComputedStyle(e).backgroundColor), expected);
    } finally { await ctx.close(); }
  }
});

test('theme changes keep the page canvas and browser theme color aligned', async () => {
  const ctx = await browser.createBrowserContext(), page = await open(sites.mail, ctx);
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.goto(sites.mail.origin, { waitUntil: 'load' });
    await page.waitForSelector('#authFormArea');
    await page.click('[data-theme-toggle]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.$eval('html', e => getComputedStyle(e).backgroundColor), 'rgb(12, 12, 11)');
    assert.deepEqual(await page.$$eval('meta[name="theme-color"]', els => els.map(e => e.content)), ['#0c0c0b', '#0c0c0b']);
  } finally { await ctx.close(); }
});

for (const name of Object.keys(folders)) {
  test(`${name}: only public assets enter Cache Storage; offline launch and reconnect work`, async () => {
    const ctx = await browser.createBrowserContext(), site = sites[name], page = await open(site, ctx);
    try {
      await page.goto(site.origin + '/?home', { waitUntil: 'load' }); await controlled(page);
      await page.evaluate(async () => {
        await fetch('/api/private').then(r => r.json());
        await fetch('/api/private').then(r => r.json());
      });
      const cached = await page.evaluate(async () => {
        const out = []; for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(new URL(r.url).pathname);
        return out.sort();
      });
      assert.deepEqual(cached, ['/assets/icons/pwa/app-192.png', '/assets/icons/pwa/app-512.png', '/assets/icons/pwa/maskable-512.png', '/offline.html']);
      // CDP's page-only network emulation doesn't stop service-worker fetches.
      // Drop fixture connections too, to simulate the whole origin going offline.
      site.offline = true;
      await page.setOfflineMode(true);
      await page.reload({ waitUntil: 'load' });
      assert.equal(await page.$eval('h1', e => e.textContent), "You're offline.");
      assert.equal(await page.$('input'), null);
      assert.equal(await page.evaluate(() => fetch('/api/private').then(() => false, () => true)), true, 'private API never falls back to cache');
      site.offline = false;
      const online = page.waitForNavigation({ waitUntil: 'load' });
      await page.setOfflineMode(false); await online;
      await page.waitForSelector('.shell');
    } finally { site.offline = false; await ctx.close(); }
  });
}

test('new workers remove legacy app-shell caches without deleting unrelated caches', async () => {
  const ctx = await browser.createBrowserContext(), site = sites.temp, page = await open(site, ctx);
  try {
    await page.goto(site.origin + '/seed.html', { waitUntil: 'load' });
    await page.evaluate(async () => {
      await (await caches.open('inpriv-temp-v6')).put('/old.html', new Response('old public shell'));
      await (await caches.open('unrelated-fixture')).put('/keep.txt', new Response('keep'));
    });
    await page.goto(site.origin, { waitUntil: 'load' }); await controlled(page);
    assert.deepEqual((await page.evaluate(() => caches.keys())).sort(), ['inpriv-public-v1', 'unrelated-fixture']);
  } finally { await ctx.close(); }
});

test('an evicted offline cache still shows a dark fallback with a working retry link', async () => {
  const ctx = await browser.createBrowserContext(), site = sites.mail, page = await open(site, ctx);
  try {
    await page.goto(site.origin + '/?home', { waitUntil: 'load' }); await controlled(page);
    await page.evaluate(async () => { for (const name of await caches.keys()) await caches.delete(name); });
    site.offline = true; await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.$eval('h1', e => e.textContent), "You're offline.");
    assert.equal(await page.$eval('body', e => getComputedStyle(e).backgroundColor), 'rgb(12, 12, 11)');
    site.offline = false; await page.setOfflineMode(false);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('a')]);
    await page.waitForSelector('#authFormArea');
  } finally { site.offline = false; await ctx.close(); }
});

test('standalone homes stay on their own origin and landing does not auto-redirect', async () => {
  for (const site of Object.values(sites)) {
    const ctx = await browser.createBrowserContext(), page = await open(site, ctx);
    try {
      let sso = 0; page.on('request', r => { if (r.url().includes('/api/public/me')) sso++; });
      await page.evaluateOnNewDocument(() => {
        const original = matchMedia;
        window.matchMedia = q => q === '(display-mode: standalone)' ? { matches: true, addEventListener() {} } : original(q);
      });
      await page.goto(site.origin, { waitUntil: 'load' });
      assert.equal(new URL(page.url()).origin, site.origin);
      assert.equal(sso, 0);
      assert.equal(await page.$eval('html', e => e.classList.contains('checking')), false);
      await page.waitForFunction(origin => document.querySelector('.top .brand')?.href === origin + '/', {}, site.origin);
    } finally { await ctx.close(); }
  }
});

test('Account offers install instructions, one native prompt per event, installed state and release notes', async () => {
  const site = sites.mail; site.user = null;
  const ctx = await browser.createBrowserContext(), page = await open(site, ctx);
  try {
    await page.evaluateOnNewDocument(() => localStorage.setItem('inpriv_theme', 'dark'));
    await page.goto(site.origin, { waitUntil: 'load' }); await page.waitForSelector('#loginForm');
    await page.type('#authUsername', 'pwatest'); await page.type('#authPassword', 'fixture-password-123');
    await page.$eval('#loginForm', e => e.requestSubmit());
    await page.waitForSelector('#searchInput');
    await page.click('.bottom-nav [data-nav="account"]'); await page.waitForSelector('#installMailBtn');
    if (shots) { await pause(400); await page.screenshot({ path: shots + '/account-install.png', fullPage: true }); }
    await page.click('#installMailBtn'); await page.waitForSelector('#mailInfoSheet.open');
    assert.match(await page.$eval('#mailInfoSheet', e => e.textContent), /Install Inpriv Mail/);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('mailInfoSheet'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'installMailBtn');
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true }); window.__prompts = 0;
      e.prompt = async () => { window.__prompts++; window.__activated = navigator.userActivation.isActive; return { outcome: 'dismissed' }; };
      dispatchEvent(e);
    });
    await page.click('#installMailBtn');
    assert.equal(await page.evaluate(() => window.__prompts), 1);
    assert.equal(await page.evaluate(() => window.__activated), true);
    assert.equal(await page.$('#mailInfoSheet'), null, 'cancelling native install does not nag with another dialog');
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = async () => { window.__prompts++; return { outcome: 'accepted' }; };
      dispatchEvent(e);
    });
    await page.click('#installMailBtn');
    await page.waitForFunction(() => /Installing/.test(document.getElementById('installMailBtn').textContent));
    await page.$eval('#installMailBtn', e => e.click());
    assert.equal(await page.evaluate(() => window.__prompts), 2, 'a pending install cannot prompt again');
    await page.evaluate(() => dispatchEvent(new Event('appinstalled')));
    assert.equal(await page.$eval('#installMailBtn', e => e.disabled), true);
    assert.match(await page.$eval('#installMailBtn', e => e.textContent), /Installed/);
    await page.click('#whatsNewBtn'); await page.waitForSelector('#mailInfoSheet.open');
    if (shots) { await pause(350); await page.evaluate(() => document.querySelectorAll('.toast').forEach(el => el.remove())); await page.screenshot({ path: shots + '/whats-new.png' }); }
    assert.ok(await page.$$eval('.release-entry', els => els.length >= 2));
    assert.ok(await page.$eval('html', e => e.scrollWidth <= innerWidth));
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'mailInfoClose');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('mailInfoSheet'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'whatsNewBtn');
  } finally { site.user = null; await ctx.close(); }
});
