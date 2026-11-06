// Real Mail page + encrypted synthetic messages, local response fixtures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import puppeteer from 'puppeteer-core';
import { listUnsubscribeHeader } from '../.mail/worker/src/list-unsubscribe.js';
import { pageResponse } from '../common/security.js';
import { importPub, seal } from './lib.mjs';

const helper = readFileSync(new URL('../common/ui/mail-unsubscribe.js', import.meta.url), 'utf8');
const scope = { window: {}, URL, Set };
runInNewContext(helper, scope);
const U = scope.window.InprivUnsubscribe;
const plain = value => JSON.parse(JSON.stringify(value));
const WEB = 'https://lists.example/unsubscribe?token=fixture%2Bonly&list=weekly';
const MAIL = 'mailto:leave@lists.example?subject=Leave%20weekly&body=Please%20remove%20me.%0AReference%3A%20fixture';
let browser, server, page, origin, user, messages = [];
const requests = [], errors = [];
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

test('receive-time capture accepts only a bounded List-Unsubscribe header', () => {
  for (const name of ['list-unsubscribe', 'List-Unsubscribe', 'LIST-UNSUBSCRIBE']) {
    assert.equal(listUnsubscribeHeader({ from: 'news@lists.example', [name]: `<${WEB}>` }), `<${WEB}>`);
  }
  for (const headers of [null, [], 'bad', {}, { 'list-unsubscribe': [] }, { 'list-unsubscribe': ' ' }, { 'list-unsubscribe': 'x'.repeat(8193) }]) {
    assert.equal(listUnsubscribeHeader(headers), null);
  }
});

test('header discovery handles alternatives and folding without changing opaque URL tokens', () => {
  assert.deepEqual(plain(U.fromHeader(`<${MAIL}>,\r\n <${WEB}>`)), { kind: 'web', href: WEB, host: 'lists.example' });
  assert.equal(U.fromHeader(`<https://lists.example/\r\n unsubscribe?token=fixture%2Bonly>`).href, 'https://lists.example/unsubscribe?token=fixture%2Bonly');
  assert.equal(U.fromHeader('(no usable link), <javascript:alert(1)>'), null);
  assert.equal(U.fromHeader('x'.repeat(8193)), null);
});

test('mailto actions preserve a single recipient, subject and body for review', () => {
  assert.deepEqual(plain(U.parse(MAIL)), { kind: 'email', to: 'leave@lists.example', subject: 'Leave weekly', body: 'Please remove me.\nReference: fixture' });
  assert.equal(U.parse('mailto:leave@lists.example').subject, 'Unsubscribe');
});

test('unsafe URLs, local hostnames and mail header injection are rejected', () => {
  for (const raw of ['javascript:alert(1)', 'data:text/html,hi', 'file:///tmp/fixture', '//lists.example/unsubscribe', '/unsubscribe', 'https://user:pass@lists.example/unsubscribe', 'http://127.0.0.1/unsubscribe', 'http://[::1]/unsubscribe', 'http://localhost/unsubscribe', 'http://host.local/unsubscribe', 'https://lists.example/\nunsafe', 'mailto:a%0d%0abcc:other@lists.example', 'mailto:a%00@lists.example', 'mailto:a@lists.example,b@lists.example', 'mailto:a@lists.example?bcc=b@lists.example', 'mailto:a@lists.example?subject=a%0d%0aBcc:b@lists.example', 'mailto:a@lists.example?subject=a&Subject=b', 'mailto:a@lists.example?body=%00', 'mailto:a@lists.example?attachment=file']) {
    assert.equal(U.parse(raw), null, raw);
  }
});

test('old plain-text messages need a labeled link or an explicit unsubscribe path', () => {
  assert.equal(U.find(null, '', `Unsubscribe: ${WEB}`).href, WEB);
  assert.equal(U.find(null, '', `Visit ${WEB}`).href, WEB);
  assert.equal(U.find(null, '', 'Unsubscribe: https://lists.example/manage?token=fixture').host, 'lists.example');
  assert.equal(U.find(null, '', 'Visit https://lists.example/news. You can unsubscribe later.'), null);
  assert.equal(U.find(null, '', 'Unsubscribe: javascript:alert(1)'), null);
});

before(async () => {
  const html = readFileSync(new URL('../.mail/index.html', import.meta.url));
  server = createServer(async (req, res) => {
    if (req.url === '/') {
      const response = await pageResponse(new Request(origin), new Response(html, { headers: { 'Content-Type': 'text/html' } }), { 'script-src': ['https://id.inpriv.xyz'], '=frame-src': ["'self'"] });
      res.writeHead(response.status, Object.fromEntries(response.headers)); return res.end(await response.text());
    }
    if (!req.url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    let data = {}, status = 200;
    if (req.url === '/api/v1/me') { status = user ? 200 : 401; data = user || { error: 'fixture: signed out' }; }
    else if (req.url === '/api/v1/login') data = { status: 'needs_init', init_ticket: 'fixture-only' };
    else if (req.url === '/api/v1/init-keys') {
      let body = ''; for await (const chunk of req) body += chunk;
      const d = JSON.parse(body);
      user = { id: 1, username: 'unsubtest', email: 'unsubtest@inpriv.xyz', public_key: d.public_key, key_id: d.key_id, ...d.envelope, quick_unlock: false, created_at: Date.now() };
      const fixtures = [
        { text: 'Weekly news', list_unsubscribe: `<${MAIL}>, <${WEB}>` },
        { text: 'An older newsletter', html: `<h1>Weekly update</h1><p>From the archive.</p><img src="https://tracker.example/pixel"><a href="${WEB}">Unsubscribe</a>` },
        { text: `A plain newsletter.\nUnsubscribe: ${WEB}` },
        { text: 'Leave by email', list_unsubscribe: `<${MAIL}>` },
        { text: 'A personal message, no list link.' },
        { text: 'Sent copy', list_unsubscribe: `<${WEB}>` },
        { text: 'Invalid actions', html: '<a href="javascript:alert(1)">Unsubscribe</a>', list_unsubscribe: '<http://127.0.0.1/unsubscribe>, <mailto:leave@lists.example?bcc=hidden@lists.example>' },
      ];
      const pub = await importPub(d.public_key);
      messages = await Promise.all(fixtures.map(async (payload, i) => ({ id: i + 1, direction: i === 5 ? 'outbound' : 'inbound', peer_address: 'news@lists.example', peer_label: 'Example newsletter', subject: 'Weekly update ' + (i + 1), is_read: 0, created_at: Date.now(), key_id: d.key_id, ...await seal(pub, JSON.stringify({ v: 1, ...payload })) })));
      data = { user };
    } else if (req.url === '/api/v1/messages') data = { items: messages };
    else if (/^\/api\/v1\/messages\/\d+$/.test(req.url)) data = messages.find(m => m.id === Number(req.url.split('/').at(-1)));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true });
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on('request', r => {
    requests.push({ url: r.url(), method: r.method() });
    if (r.url() === 'https://id.inpriv.xyz/id.js') return r.respond({ status: 200, contentType: 'text/javascript', body: '' });
    return r.url().startsWith(origin) || r.url().startsWith('about:') ? r.continue() : r.abort();
  });
  page.on('pageerror', e => errors.push(String(e.stack || e)));
  await page.goto(origin, { waitUntil: 'load' }); await page.waitForSelector('#loginForm');
  await page.type('#authUsername', 'unsubtest'); await page.type('#authPassword', 'fixture-password-123');
  await page.$eval('#loginForm', e => e.requestSubmit()); await page.waitForSelector('.msg-card');
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(e => e.remove()));
  assert.deepEqual(errors, [], 'fixture setup has no page errors');
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });

async function open(id, sent = false) {
  if (await page.$('#viewBackBtn')) {
    await page.click('#viewBackBtn');
    await page.waitForFunction(() => !document.querySelector('.reader'));
  }
  await page.click(`.mail-tab[data-tab="${sent ? 'outbound' : 'inbound'}"], [data-tab="${sent ? 'outbound' : 'inbound'}"]`);
  await page.click(`.msg-card[data-id="${id}"]`);
  await page.waitForFunction(() => !document.querySelector('#viewBody')?.hasAttribute('aria-busy'));
}

test('sender header offers Unsubscribe; discovery and confirmation load nothing from the sender', async () => {
  await open(1);
  assert.equal(await page.$eval('#viewUnsubscribeBtn', e => e.classList.contains('hidden')), false);
  await page.click('#viewUnsubscribeBtn'); await page.waitForSelector('#mailInfoSheet.open');
  assert.match(await page.$eval('#mailInfoSheet', e => e.textContent), /lists\.example/);
  const link = await page.$eval('#unsubscribeOpenLink', e => ({ href: e.href, target: e.target, rel: e.rel, referrer: e.referrerPolicy }));
  assert.deepEqual(link, { href: WEB, target: '_blank', rel: 'noopener noreferrer', referrer: 'no-referrer' });
  await page.setViewport({ width: 320, height: 844 });
  assert.equal(await page.$eval('.info-sheet', e => e.scrollWidth <= e.clientWidth + 1), true);
  await page.setViewport({ width: 390, height: 844 });
  if (shots) { await new Promise(r => setTimeout(r, 350)); await page.screenshot({ path: `${shots}/unsubscribe-web.png` }); }
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('mailInfoSheet'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'viewUnsubscribeBtn');
  assert.deepEqual(requests.filter(r => /lists\.example|tracker\.example/.test(r.url)), []);
});

test('older rich and plain messages expose their clearly provided unsubscribe links', async () => {
  for (const id of [2, 3]) {
    await open(id);
    assert.equal(await page.$eval('#viewUnsubscribeBtn', e => e.classList.contains('hidden')), false);
  }
  assert.deepEqual(requests.filter(r => /lists\.example|tracker\.example/.test(r.url)), []);
});

test('an email unsubscribe opens a correctly filled draft without sending it', async () => {
  await open(4);
  await page.click('#viewUnsubscribeBtn'); await page.waitForSelector('#mailInfoSheet.open');
  await page.click('#unsubscribeReviewBtn'); await page.waitForSelector('#cmpBody');
  assert.equal(await page.$eval('#cmpTo', e => e.value), 'leave@lists.example');
  assert.equal(await page.$eval('#cmpSubject', e => e.value), 'Leave weekly');
  assert.equal(await page.$eval('#cmpBody', e => e.value), 'Please remove me.\nReference: fixture');
  assert.equal(await page.$eval('#composeModeSeg .active', e => e.dataset.mode), 'external');
  assert.match(await page.$eval('#composeCloseBtn', e => getComputedStyle(e.closest('.modal-sheet')).backgroundColor), /^(rgb\([^/]+\)|color\(srgb [^/]+\))$/);
  assert.equal(requests.filter(r => r.url.endsWith('/messages/send')).length, 0);
  if (shots) { await new Promise(r => setTimeout(r, 350)); await page.screenshot({ path: `${shots}/unsubscribe-draft.png` }); }
  await page.click('#composeCloseBtn'); await page.waitForFunction(() => !document.getElementById('composeCloseBtn'));
});

test('personal messages, sent copies and unsafe actions have no Unsubscribe button', async () => {
  for (const id of [5, 6, 7]) {
    await open(id, id === 6);
    assert.equal(await page.$eval('#viewUnsubscribeBtn', e => e.classList.contains('hidden')), true);
  }
});

test('reader, pinned header and action bar are opaque in both themes and fit phones', async () => {
  await open(2);
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 900]) {
    await page.setViewport({ width, height: 844 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const surfaces = await page.$$eval('.modal-sheet.reader, .reader .view-header, .reader .view-actions-bar', els => els.map(e => {
      const s = getComputedStyle(e); return { color: s.backgroundColor, image: s.backgroundImage };
    }));
    for (const surface of surfaces) {
      assert.match(surface.color, /^(rgb\([^/]+\)|color\(srgb [^/]+\))$/, JSON.stringify(surface));
      assert.equal(surface.image, 'none');
    }
    assert.equal(await page.$eval('html', e => e.scrollWidth <= innerWidth), true);
    assert.equal(await page.$eval('.reader .view-sheet', e => e.scrollWidth <= e.clientWidth + 1), true);
    assert.ok(await page.$eval('#viewUnsubscribeBtn', e => e.getBoundingClientRect().height >= 44));
    if (shots && width === 390) { await new Promise(r => setTimeout(r, 400)); await page.screenshot({ path: `${shots}/reader-${theme}.png` }); }
  }
  assert.deepEqual(errors, []);
});
