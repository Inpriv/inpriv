// Local Workers only (tests/local.sh up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import * as L from './lib.mjs';

test('ID accepts eight-character passwords at registration and change, rejects seven', async () => {
  const id = new L.Client(L.URLS.id);
  const username = 'min' + L.rand();
  assert.equal((await id.post('/api/register', { username, password: 'seven77' })).status, 400);
  assert.equal((await id.post('/api/register', { username, password: 'eight888' })).status, 200);
  assert.equal((await id.post('/api/login', { username, password: 'eight888' })).status, 200);
  assert.equal((await id.post('/api/password/change', { current: 'eight888', next: 'short77' })).status, 400);
  assert.equal((await id.post('/api/password/change', { current: 'eight888', next: 'next8888' })).status, 200);
  const fresh = new L.Client(L.URLS.id);
  assert.equal((await fresh.post('/api/login', { username, password: 'next8888' })).status, 200);
});

test('Mail recommends twelve, refuses seven, and creates and opens a mailbox with eight', async () => {
  const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || '/usr/bin/firefox', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://localhost:8799/?register=1', { waitUntil: 'load' });
    await page.waitForSelector('#regForm');
    const label = await page.$eval('label[for="regPassword"]', el => el.textContent);
    assert.match(label, /8\+/);
    assert.match(label, /12\+ recommended/);
    const username = 'minweb' + L.rand();
    await page.type('#regUsername', username);
    await page.type('#regPassword', 'seven77');
    await page.$eval('#regForm', el => el.requestSubmit());
    await page.waitForFunction(() => /at least 8/.test(document.querySelector('.toast')?.textContent || ''));
    await page.$eval('#regPassword', el => { el.value = 'eight888'; });
    await page.$eval('#regForm', el => el.requestSubmit());
    await page.waitForSelector('#searchInput', { timeout: 30000 });
    const id = new L.Client(L.URLS.id);
    assert.equal((await id.post('/api/login', { username, password: 'eight888' })).status, 200);
    const ctx = await browser.createBrowserContext();
    const fresh = await ctx.newPage();
    await fresh.setViewport({ width: 390, height: 844 });
    await fresh.goto('http://localhost:8799/', { waitUntil: 'load' });
    await fresh.waitForSelector('#loginForm');
    await fresh.type('#authUsername', username);
    await fresh.type('#authPassword', 'eight888');
    await fresh.$eval('#loginForm', el => el.requestSubmit());
    await fresh.waitForSelector('#searchInput', { timeout: 30000 });
    assert.equal(await fresh.$('#sessionUnlockForm'), null);
    await fresh.click('.bottom-nav [data-nav="account"]');
    await fresh.waitForSelector('#chgPassBtn');
    await fresh.click('#chgPassBtn');
    await fresh.type('#chgOld', 'eight888');
    await fresh.type('#chgNew', 'short77');
    await fresh.type('#chgNewConfirm', 'short77');
    await fresh.$eval('#chgForm', el => el.requestSubmit());
    await fresh.waitForFunction(() => /at least 8/.test(document.querySelector('.toast')?.textContent || ''));
    await fresh.$eval('#chgNew', el => { el.value = 'phrase88'; });
    await fresh.$eval('#chgNewConfirm', el => { el.value = 'phrase88'; });
    await fresh.$eval('#chgForm', el => el.requestSubmit());
    await fresh.waitForFunction(() => [...document.querySelectorAll('.toast')].some(el => /Passphrase changed/.test(el.textContent)), { timeout: 30000 });
  } finally { await browser.close(); }
});
