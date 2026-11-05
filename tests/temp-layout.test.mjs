// Exercise the real Temp page against local response fixtures; no live inboxes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

let browser, server, origin;
let address;
before(async () => {
  const html = readFileSync(new URL('../.temp/index.html', import.meta.url));
  server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    if (!req.url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/mailbox'
      ? { address, token: 'local-fixture-only', expires_at: Date.now() + 86400000 }
      : { messages: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true });
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });

for (const name of ['sample-layout-12345', 'a'.repeat(32)]) {
  for (const width of [320, 360, 390, 768]) {
    test(`${name.length}-character local part at ${width}px stays on one line and copies in full`, async () => {
      address = name + '@inpriv.xyz';
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      try {
        await page.setViewport({ width, height: 844 });
        await page.goto(origin, { waitUntil: 'load' });
        await page.waitForFunction(() => !document.querySelector('#addrValue').classList.contains('skeleton'));
        const measure = () => page.$eval('#addrValue', e => {
          const range = document.createRange(); range.selectNodeContents(e);
          const s = getComputedStyle(e);
          return { text: e.textContent, lines: range.getClientRects().length, font: parseFloat(s.fontSize), textWidth: range.getBoundingClientRect().width, width: e.clientWidth, pageWidth: document.documentElement.scrollWidth };
        });
        const small = await measure();
        assert.equal(small.text, address);
        assert.equal(small.lines, 1);
        assert.ok(small.font >= 12);
        assert.ok(small.pageWidth <= width);
        if (name.length === 19 || small.font > 12) assert.ok(small.textWidth <= small.width + 1, JSON.stringify(small));
        await page.evaluate(() => { navigator.clipboard.writeText = async value => { window.__copied = value; }; });
        await page.click('#copyBtn');
        assert.equal(await page.evaluate(() => window.__copied), address);
        await page.setViewport({ width: 1280, height: 844 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const large = await measure();
        assert.equal(large.lines, 1);
        assert.ok(large.textWidth <= large.width + 1, JSON.stringify(large));
        assert.ok(large.font >= small.font);
        if (large.width > small.width && small.font < 19) assert.ok(large.font > small.font);
      } finally { await ctx.close(); }
    });
  }
}
