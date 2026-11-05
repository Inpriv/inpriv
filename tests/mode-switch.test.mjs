// Local Mail + Temp Workers; no production navigation (tests/local.sh up).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
let browser, calmBrowser;
before(async () => {
  const options = { browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true };
  browser = await puppeteer.launch(options);
  calmBrowser = await puppeteer.launch({ ...options, extraPrefsFirefox: { 'ui.prefersReducedMotion': 1 } });
});
after(async () => { await browser?.close(); await calmBrowser?.close(); });
const urls = { mail: 'http://localhost:8799/', temp: 'http://localhost:8796/' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open(mode = 'mail', reduce = false) {
  const ctx = await (reduce ? calmBrowser : browser).createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(() => {
    window.__motion = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      window.__motion.push({ tag: this.id || this.className, frames, options });
      return animate.call(this, frames, options);
    };
  });
  await page.goto(urls[mode], { waitUntil: 'load' });
  await ready(page, mode);
  return { ctx, page };
}
async function ready(page, mode) {
  await page.waitForSelector('[data-mode-switch="' + mode + '"] .liquid-thumb');
  if (mode === 'mail') await page.waitForSelector('#authFormArea');
  await page.evaluate(urls => {
    document.querySelectorAll('[data-mode-switch] a[data-mode]').forEach(a => { a.href = urls[a.dataset.mode]; });
  }, urls);
}
async function switchTo(page, mode, keyboard = false) {
  const navigated = page.waitForNavigation({ waitUntil: 'load' });
  if (keyboard) {
    await page.focus('[data-mode-switch] [aria-current="page"]');
    await page.keyboard.press(mode === 'temp' ? 'ArrowRight' : 'ArrowLeft');
  } else await page.click('[data-mode-switch] [data-mode="' + mode + '"]');
  await navigated;
  await ready(page, mode);
}

test('directional handoff in both directions; Back restores the real selection', async () => {
  const { page, ctx } = await open();
  try {
    await switchTo(page, 'temp');
    assert.equal(new URL(page.url()).hash, '');
    let frames = await page.evaluate(() => window.__motion.flatMap(a => a.frames));
    assert.ok(frames.some(f => f.transform?.includes('28px')));
    await sleep(700);
    assert.equal(await page.$eval('.hero', e => getComputedStyle(e).opacity), '1');
    await switchTo(page, 'mail', true);
    frames = await page.evaluate(() => window.__motion.flatMap(a => a.frames));
    assert.ok(frames.some(f => f.transform?.includes('-28px')));
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.port === '8796');
    await ready(page, 'temp');
    await sleep(700);
    assert.equal(await page.$eval('[data-mode-switch] [aria-current="page"]', e => e.dataset.mode), 'temp');
    assert.equal(await page.$eval('.hero', e => getComputedStyle(e).opacity), '1');
    assert.equal(await page.$eval('html', e => e.hasAttribute('data-mode-leaving')), false);
  } finally { await ctx.close(); }
});

test('rapid taps navigate once; outgoing content has real intermediate frames', async () => {
  const { page, ctx } = await open();
  try {
    const loaded = page.waitForNavigation({ waitUntil: 'load' });
    await page.$eval('[data-mode="temp"]', a => { a.click(); a.click(); a.click(); });
    await sleep(75);
    const opacity = await page.$eval('#mainView', e => +getComputedStyle(e).opacity);
    assert.ok(opacity > 0 && opacity < 1, 'intermediate opacity: ' + opacity);
    await loaded;
    await ready(page, 'temp');
    const frames = await page.evaluate(() => window.__motion.flatMap(a => a.frames));
    assert.ok(frames.every(f => Object.keys(f).every(k => ['opacity', 'transform', 'offset'].includes(k))));
  } finally { await ctx.close(); }
});

test('reduced motion navigates directly and keeps the destination visible', async () => {
  const { page, ctx } = await open('mail', true);
  try {
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await switchTo(page, 'temp');
    assert.equal(new URL(page.url()).hash, '');
    assert.deepEqual(await page.evaluate(() => window.__motion), []);
    assert.equal(await page.$eval('.hero', e => getComputedStyle(e).opacity), '1');
  } finally { await ctx.close(); }
});

test('registration notice is separated from the submit button', async () => {
  const { page, ctx } = await open();
  try {
    await page.click('#authSeg [data-mode="register"]');
    const gap = await page.evaluate(() => document.querySelector('#regSubmitBtn + .sec-badge').getBoundingClientRect().top - document.querySelector('#regSubmitBtn').getBoundingClientRect().bottom);
    assert.ok(gap >= 14, 'notice gap: ' + gap);
  } finally { await ctx.close(); }
});

test('modified clicks retain their native action instead of starting a handoff', async () => {
  const { page, ctx } = await open();
  try {
    const result = await page.evaluate(() => {
      const link = document.querySelector('[data-mode="temp"]');
      link.href = '#native-link';
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true });
      link.dispatchEvent(event);
      return { prevented: event.defaultPrevented, leaving: document.documentElement.hasAttribute('data-mode-leaving') };
    });
    assert.deepEqual(result, { prevented: false, leaving: false });
  } finally { await ctx.close(); }
});

test('dragging the pill selects Temp and desktop headers keep their position', async () => {
  const { page, ctx } = await open();
  try {
    await page.setViewport({ width: 1280, height: 860 });
    await sleep(250);
    const before = await page.$eval('.switcher', e => e.getBoundingClientRect().right);
    const selected = await page.$eval('[data-mode="mail"]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const target = await page.$eval('[data-mode="temp"]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const loaded = page.waitForNavigation({ waitUntil: 'load' });
    await page.mouse.move(selected.x, selected.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.mouse.up();
    await loaded;
    await ready(page, 'temp');
    await sleep(700);
    const after = await page.$eval('.switcher', e => e.getBoundingClientRect().right);
    assert.ok(Math.abs(before - after) < 2, `switcher right edge: ${before} → ${after}`);
  } finally { await ctx.close(); }
});
