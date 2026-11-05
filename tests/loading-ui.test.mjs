// Local Workers only (tests/local.sh up).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import * as L from './lib.mjs';
const mail = 'http://localhost:8799/', temp = 'http://localhost:8796/';
const pause = ms => new Promise(r => setTimeout(r, ms));
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (p, name) => { if (shots) await p.screenshot({ path: shots + '/' + name + '.png', fullPage: true }); };
let browser, page, ctx;
const errors = [], username = 'loading' + L.rand();
before(async () => {
  browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true });
  ctx = await browser.createBrowserContext(); page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  page.on('pageerror', e => errors.push(String(e)));
});
after(async () => { await browser?.close(); });

test('auth forms resize and cross-slide; rapid changes leave one usable form', async () => {
  await page.goto(mail, { waitUntil: 'load' });
  await page.waitForSelector('#loginForm');
  const before = await page.$eval('#authFormArea', e => e.getBoundingClientRect().height);
  await page.click('#authSeg [data-mode="register"]');
  await pause(90);
  const middle = await page.$eval('#authFormArea', e => e.getBoundingClientRect().height);
  await pause(320);
  const end = await page.$eval('#authFormArea', e => e.getBoundingClientRect().height);
  assert.ok(before < middle && middle < end, `${before} < ${middle} < ${end}`);
  assert.equal(await page.$('.auth-ghost'), null);
  for (const mode of ['login', 'register', 'login']) {
    await page.$eval('#authSeg [data-mode="' + mode + '"]', e => e.click());
    await pause(40);
  }
  await pause(350);
  assert.equal(await page.$$eval('#authFormArea form', els => els.length), 1);
  assert.equal(await page.$eval('#authFormArea', e => e.style.height), '');
  assert.ok(await page.$('#loginForm'));
});

test('account creation has readable button progress and no separate visible status row', async () => {
  await page.click('#authSeg [data-mode="register"]'); await pause(320);
  await page.type('#regUsername', username); await page.type('#regPassword', 'test-password-123');
  const account = gate(), login = gate();
  await page.setRequestInterception(true);
  const intercept = async r => {
    if (r.url().endsWith('/api/register') && r.method() === 'POST') await account.promise;
    if (r.url().endsWith('/api/v1/login')) await login.promise;
    if (!r.isInterceptResolutionHandled()) await r.continue();
  };
  page.on('request', intercept);
  try {
    await page.$eval('#regForm', e => e.requestSubmit());
    await page.waitForSelector('#regSubmitBtn[aria-busy="true"]');
    assert.match(await page.$eval('#regSubmitBtn', e => e.textContent), /Creating account/);
    assert.equal(await page.$eval('#regSubmitBtn', e => getComputedStyle(e).opacity), '1');
    assert.equal(await page.$eval('#regStatus', e => e.getBoundingClientRect().height), 1);
    assert.equal(await page.$eval('#authSeg [data-mode="login"]', e => e.disabled), true);
    await shot(page, 'creating-account');
    account.release();
    await page.waitForFunction(() => /Preparing mailbox/.test(document.querySelector('#regSubmitBtn')?.textContent || ''));
    await shot(page, 'preparing-mailbox');
    login.release();
    await page.waitForSelector('#searchInput', { timeout: 30000 });
  } finally { account.release(); login.release(); page.off('request', intercept); await page.setRequestInterception(false); }
});

test('a slow Mail return shows opening and fetching states, then a working retry', async () => {
  const session = gate(), messages = gate(); let fail = true;
  await page.setRequestInterception(true);
  const intercept = async r => {
    if (r.url().endsWith('/api/v1/me')) await session.promise;
    if (r.url().endsWith('/api/v1/messages') && fail) {
      await messages.promise; fail = false;
      return r.respond({ status: 500, contentType: 'application/json', body: '{"error":"test-only network failure"}' });
    }
    if (!r.isInterceptResolutionHandled()) await r.continue();
  };
  page.on('request', intercept);
  try {
    await page.goto('about:blank');
    await page.goto(mail + '#inpriv-switch=temp', { waitUntil: 'load' });
    await page.waitForFunction(() => /Opening Mail/.test(document.querySelector('#mainView')?.textContent || ''));
    assert.equal(await page.$$eval('.mail-placeholder', els => els.length), 3);
    await pause(650);
    const openingTop = await page.$eval('.mail-loading', e => e.getBoundingClientRect().top);
    await shot(page, 'opening-mail');
    session.release();
    await page.waitForFunction(() => /Fetching your mail/.test(document.querySelector('#messageListArea')?.textContent || ''));
    const fetchingTop = await page.$eval('.mail-loading', e => e.getBoundingClientRect().top);
    assert.ok(Math.abs(openingTop - fetchingTop) < 12, 'opening panel stays aligned with the inbox');
    assert.equal(await page.$eval('#mainView', e => getComputedStyle(e).opacity), '1', 'opening never fades back to a blank page');
    await page.evaluate(() => { window.__originalNav = document.querySelector('.bottom-nav'); });
    assert.equal(await page.$('.empty-state-title'), null, 'no false empty inbox while fetching');
    await shot(page, 'fetching-mail');
    messages.release();
    await page.waitForSelector('#retryMailBtn');
    await page.click('#retryMailBtn');
    await page.waitForFunction(() => /Your inbox is clear/.test(document.querySelector('#messageListArea')?.textContent || ''));
    assert.equal(await page.evaluate(() => window.__originalNav === document.querySelector('.bottom-nav')), true, 'counts never rebuild the bottom bar');
    await page.click('.bottom-nav [data-nav="sent"]');
    assert.equal(await page.$('#messageListArea .mail-loading'), null, 'cached tabs do not flash a loader');
  } finally { session.release(); messages.release(); page.off('request', intercept); await page.setRequestInterception(false); }
});

test('reader shows the known subject while opening and can close during a slow fetch', async () => {
  const row = L.db('mail').prepare('SELECT id, public_key, key_id FROM users WHERE username = ?').get(username);
  const e = await L.seal(await L.importPub(row.public_key), JSON.stringify({ v: 1, text: 'Read me after loading.' }));
  L.db('mail').prepare('INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject, encrypted_aes_key, iv, ciphertext, auth_tag, created_at, key_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(row.id, 'inbound', 'test@example.com', 'Test sender', 'A real subject', e.encrypted_aes_key, e.iv, e.ciphertext, e.auth_tag, Date.now(), row.key_id);
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.msg-card');
  const body = gate(); let delay = true;
  await page.setRequestInterception(true);
  const intercept = async r => {
    if (/\/api\/v1\/messages\/\d+$/.test(r.url()) && delay) { delay = false; await body.promise; }
    if (!r.isInterceptResolutionHandled()) await r.continue();
  };
  page.on('request', intercept);
  try {
    await page.click('.msg-card');
    assert.equal(await page.$eval('#viewSubject', e => e.textContent), 'A real subject');
    assert.match(await page.$eval('#viewBody', e => e.textContent), /Opening message/);
    assert.equal(await page.$eval('#viewBody', e => e.getAttribute('aria-busy')), 'true');
    await shot(page, 'opening-message');
    await page.click('#viewBackBtn'); body.release(); await pause(500);
    assert.equal(await page.$('.modal-sheet.reader'), null);
    await page.click('.msg-card');
    await page.waitForFunction(() => /Read me after loading/.test(document.querySelector('#viewBody')?.textContent || ''));
    assert.equal(await page.$eval('#viewBody', e => e.hasAttribute('aria-busy')), false);
  } finally { body.release(); page.off('request', intercept); await page.setRequestInterception(false); }
  assert.deepEqual(errors, []);
});

test('Temp explains reservation and restoration without exposing a fake address', async () => {
  const p = await ctx.newPage(); await p.setViewport({ width: 390, height: 844 });
  const reserve = gate(), restore = gate(); let posts = 0, failNext = false;
  await p.setRequestInterception(true);
  p.on('request', async r => {
    if (r.url().endsWith('/api/mailbox')) {
      if (r.method() === 'POST') {
        posts++; await reserve.promise;
        if (failNext) { failNext = false; return r.respond({ status: 500, contentType: 'application/json', body: '{"error":"test-only reservation failure"}' }); }
      }
      else if (r.method() === 'GET') await restore.promise;
    }
    if (!r.isInterceptResolutionHandled()) await r.continue();
  });
  try {
    await p.goto(temp + '#inpriv-switch=mail', { waitUntil: 'load' });
    assert.match(await p.$eval('#addrValue', e => e.textContent), /Reserving…/);
    assert.equal(await p.$eval('#addrValue', e => e.getAttribute('aria-busy')), 'true');
    assert.equal(await p.$eval('#copyBtn', e => e.disabled), true);
    await shot(p, 'reserving-temp');
    reserve.release();
    await p.waitForFunction(() => /@inpriv\.xyz$/.test(document.querySelector('#addrValue').textContent));
    await p.reload({ waitUntil: 'load' });
    await p.waitForFunction(() => /Opening your temporary inbox/.test(document.querySelector('#addrValue').textContent));
    restore.release();
    await p.waitForFunction(() => /@inpriv\.xyz$/.test(document.querySelector('#addrValue').textContent));
    assert.equal(posts, 1, 'restoring never reserves another address');
    assert.equal(await p.$eval('#addrValue', e => e.hasAttribute('aria-busy')), false);
    assert.equal(await p.$eval('#copyBtn', e => e.disabled), false);
    failNext = true;
    await p.click('#newBtn');
    await p.waitForFunction(() => /Could not reserve/.test(document.querySelector('#addrValue').textContent));
    assert.equal(await p.$eval('#addrValue', e => e.hasAttribute('aria-busy')), false);
    assert.equal(await p.$eval('#copyBtn', e => e.disabled), true);
    await p.click('#newBtn');
    await p.waitForFunction(() => /@inpriv\.xyz$/.test(document.querySelector('#addrValue').textContent));
  } finally { reserve.release(); restore.release(); await p.close(); }
});

test('reduced motion skips form transitions and placeholder pulsing', async () => {
  const calm = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true, extraPrefsFirefox: { 'ui.prefersReducedMotion': 1 } });
  const wait = gate();
  try {
    const p = await calm.newPage(); await p.setRequestInterception(true);
    p.on('request', async r => { if (r.url().endsWith('/api/v1/me')) await wait.promise; if (!r.isInterceptResolutionHandled()) await r.continue(); });
    await p.goto(mail, { waitUntil: 'load' }); await p.waitForSelector('.mail-placeholders');
    assert.equal(await p.$eval('.mail-placeholders', e => getComputedStyle(e).animationName), 'none');
    wait.release(); await p.waitForSelector('#loginForm');
    await p.click('#authSeg [data-mode="register"]');
    assert.equal(await p.$('.auth-ghost'), null);
    assert.equal(await p.$eval('#authFormArea', e => e.getAnimations().length), 0);
  } finally { wait.release(); await calm.close(); }
});
