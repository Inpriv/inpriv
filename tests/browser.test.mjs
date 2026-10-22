// The real Mail and Temp pages in headless Firefox, with every network
// request recorded. Needs tests/local.sh up and puppeteer-core
// (cd tests && npm install). FIREFOX=/path/to/firefox overrides the binary.
// SHOTS=dir saves phone-sized screenshots of the new screens.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import * as L from "./lib.mjs";

// pages are opened on localhost: the wrangler dev proxy rewrites 127.0.0.1
// inside response headers (the CSP among them), localhost it leaves alone
const URLS = { ...L.URLS, mail: "http://localhost:8799", temp: "http://localhost:8796" };
const PW = "account-password-1";
const PP = "violet otter lantern 42";
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let browser;
before(async () => {
  browser = await puppeteer.launch({ browser: "firefox", executablePath: process.env.FIREFOX || "/usr/bin/firefox", headless: true });
});
after(async () => { await browser?.close(); });

// A phone-sized page in its own profile, recording requests and page errors.
async function openPage(url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const log = { requests: [], errors: [], sent: [] };
  // URLs and headers come from the network; Firefox's driver doesn't expose
  // request bodies, so the page records what it sends (fetch, XHR, beacons)
  await page.evaluateOnNewDocument(() => {
    window.__sent = [];
    const rec = (url, body) => window.__sent.push({ url: String(url), body: typeof body === "string" ? body : body ? "[binary]" : "" });
    const f = window.fetch;
    window.fetch = function (input, init) { rec(input && input.url || input, init && init.body); return f.apply(this, arguments); };
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) { rec(this.__u, b); return send.apply(this, arguments); };
    const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (beacon) navigator.sendBeacon = (u, b) => { rec(u, b); return beacon(u, b); };
  });
  page.on("request", (r) => log.requests.push({ url: r.url(), method: r.method(), body: "", headers: JSON.stringify(r.headers()) }));
  log.bodies = async () => { try { return await page.evaluate(() => window.__sent || []); } catch { return []; } };
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") log.errors.push(m.text()); });
  if (url) await page.goto(url, { waitUntil: "load" });
  return { page, ctx, log };
}
// after the 0.6 s entrance animation, so the screen is fully drawn
const shot = async (page, name) => { if (SHOTS) { await L.sleep(800); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };
// after "Load images", only image requests may go out: never stylesheets,
// fonts, frames, scripts, media, forms, pings or refreshes
const NEVER = /import\.css|l\.css|f\.woff|refresh|frame|obj|emb|script|onerror|ping|v\.mp4|a\.mp3|svg\.png|form|poster|2x\.png|pic\.webp/;
const type = async (page, sel, text) => { await page.waitForSelector(sel, { visible: true }); await page.$eval(sel, (el) => { el.value = ""; }); await page.type(sel, text); };
// submit a form directly: a toast from the previous attempt can sit over the
// button on a phone-sized screen
const submit = (page, form) => page.$eval(form, (f) => f.requestSubmit());
const toastText = (page) => page.$$eval(".toast", (ts) => ts.map((t) => t.textContent).join(" | "));
// every request whose URL, headers or body contains the secret
const leaks = async (log, secret) => [
  ...log.requests.filter((r) => r.url.includes(secret) || r.headers.includes(secret)),
  ...log.sent.concat(await log.bodies()).filter((r) => r.url.includes(secret) || r.body.includes(secret)),
];
// bodies recorded by pages that were navigated away from
async function keepBodies(log) { log.sent.push(...(await log.bodies())); }
// requests to anything but this machine (data: and about: load nothing)
const thirdParty = (log) => log.requests.filter((r) => { try { const h = new URL(r.url).hostname; return !["127.0.0.1", "localhost"].includes(h) && !r.url.startsWith("data:") && !r.url.startsWith("about:"); } catch { return false; } });

async function register(page, u) {
  await page.goto(URLS.mail + "/?register=1", { waitUntil: "load" });
  await page.waitForSelector("#regForm", { visible: true });
  await type(page, "#regUsername", u);
  await type(page, "#regPassword", PW);
  await type(page, "#regPasswordConfirm", PW);
  await type(page, "#regPassphrase", PP);
  await type(page, "#regPassphraseConfirm", PP);
  await shot(page, "01-register");
  await page.click("#regSubmitBtn");
  await page.waitForSelector("#searchInput", { timeout: 60000 });
}

// a format-1 mailbox as the old flow left it, with one message to its key
async function seedLegacy(u, text) {
  const key = await L.newKey();
  const env = await L.legacyEnvelope(PW, key.pkcs8);
  const salt = L.b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = L.b64(await L.legacyHash(PW, salt));
  L.db("id").prepare("INSERT INTO users (id, username, email, pass_hash, pass_salt, pass_iters, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u, `${u}@inpriv.xyz`, hash, salt, 300000, Date.now());
  L.db("mail").prepare(`INSERT INTO users (username, address, auth_hash, auth_salt, public_key, encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(u, `${u}@inpriv.xyz`, hash, salt, key.spki, env.encrypted_private_key, env.priv_iv, env.priv_salt, 300000, Date.now());
  await seedMail(u, { text, subject: "Before the upgrade" });
  return key;
}

// a message as inbound mail stores it: payload sealed to the current key
async function seedMail(u, { text = "", html = "", subject = "Hello" }) {
  const row = L.db("mail").prepare("SELECT id, public_key, key_id FROM users WHERE username = ?").get(u);
  const payload = { v: 1, text };
  if (html) payload.html = html;
  const e = await L.seal(await L.importPub(row.public_key), JSON.stringify(payload));
  L.db("mail").prepare(`INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject, encrypted_aes_key, iv, ciphertext, auth_tag, created_at, key_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, "inbound", "news@shop.example", "Shop", subject, e.encrypted_aes_key, e.iv, e.ciphertext, e.auth_tag, Date.now(), row.key_id);
}

const TRACKER_HTML = `<html><head><style>@import url(https://t.invalid/import.css);
  body{background:url(https://t.invalid/body.png)} @font-face{font-family:x;src:url(https://t.invalid/f.woff)}</style>
  <link rel="stylesheet" href="https://t.invalid/l.css"><meta http-equiv="refresh" content="0;url=https://t.invalid/refresh"></head>
  <body background="https://t.invalid/bg.png"><h1 style="background-image:url(https://t.invalid/inline.png)">Big sale</h1>
  <img src="https://img.invalid/pixel.gif" width="1" height="1"><img src="https://img.invalid/hero.png" alt="Hero" srcset="https://t.invalid/2x.png 2x">
  <picture><source srcset="https://t.invalid/pic.webp"><img src="https://img.invalid/pic.png" alt="pic"></picture>
  <video poster="https://t.invalid/poster.png" src="https://t.invalid/v.mp4"></video><audio src="https://t.invalid/a.mp3"></audio>
  <iframe src="https://t.invalid/frame"></iframe><object data="https://t.invalid/obj"></object><embed src="https://t.invalid/emb">
  <svg><image href="https://t.invalid/svg.png"/></svg><form action="https://t.invalid/form"><input name="q"><button>Go</button></form>
  <script>fetch("https://t.invalid/script")</script><img src="x" onerror="fetch('https://t.invalid/onerror')">
  <a href="https://shop.example/deal" ping="https://t.invalid/ping">See the deal</a> <a href="javascript:alert(1)">js</a>
  ${"<p>Long message line.</p>".repeat(300)}<p id="end">The end.</p></body></html>`;

describe("Mail in the browser", () => {
  const u = "web" + L.rand();
  let s;
  before(async () => { s = await openPage(); });

  test("sign-up: the passphrase never leaves the page; the password only goes to sign-in", async () => {
    await register(s.page, u);
    await shot(s.page, "02-inbox");
    assert.deepEqual(await leaks(s.log, PP), [], "passphrase in a request");
    const withPw = (await leaks(s.log, PW)).map((r) => new URL(r.url, URLS.mail).pathname);
    assert.deepEqual([...new Set(withPw)].sort(), ["/api/register", "/api/v1/login"]);
    assert.equal(await s.page.evaluate(() => localStorage.getItem("inpriv_token")), null, "no session token in storage");
    const row = L.db("mail").prepare("SELECT key_format FROM users WHERE username = ?").get(u);
    assert.equal(row.key_format, 2);
  });

  test("this device opens again without the passphrase (Skip mailbox passphrase on)", async () => {
    await keepBodies(s.log);
    await s.page.reload({ waitUntil: "load" });
    await s.page.waitForSelector("#searchInput", { timeout: 30000 });
    assert.deepEqual(await leaks(s.log, PP), []);
  });

  test("a long inbox on a tall screen fades in top to bottom, with no gaps", async () => {
    for (let i = 0; i < 30; i++) await seedMail(u, { text: "Filler " + i, subject: "Filler " + i });
    await s.page.setViewport({ width: 905, height: 1315 });
    try { await tallInbox(); } finally { await s.page.setViewport({ width: 390, height: 844 }); }
  });
  async function tallInbox() {
    await keepBodies(s.log);
    await s.page.reload({ waitUntil: "load" });
    await s.page.waitForSelector(".msg-card", { timeout: 30000 });
    // opacity of every card that starts inside the window, sampled while
    // the cards animate in: a card may never be ahead of the one above it
    const sample = () => s.page.$$eval(".msg-card", (cs) => cs
      .filter((c) => c.getBoundingClientRect().top < innerHeight)
      .map((c) => +getComputedStyle(c).opacity));
    const seen = [];
    for (let t = 0; t < 8; t++) { seen.push(await sample()); await L.sleep(60); }
    await L.sleep(800);
    const done = await sample();
    for (const ops of seen) {
      for (let i = 1; i < ops.length; i++) assert.ok(ops[i] <= ops[i - 1] + 0.05, `card ${i + 1} ahead of card ${i}: ${ops.map((o) => o.toFixed(2)).join(" ")}`);
    }
    assert.ok(done.length > 12, `a tall window shows more than 12 cards (${done.length})`);
    assert.ok(done.every((o) => o === 1), "all on-screen cards end fully shown");
    // cards below the window don't animate at all
    const firstStill = await s.page.$eval(".msg-card.still", (c) => c.getBoundingClientRect().top);
    assert.ok(firstStill >= 1315, `first unanimated card at ${firstStill}px`);
  }

  test("opening a newsletter contacts nobody; Load images is a deliberate step", async () => {
    await seedMail(u, { text: "Big sale (text part)", html: TRACKER_HTML, subject: "Big sale" });
    await keepBodies(s.log);
    await s.page.reload({ waitUntil: "load" });
    await s.page.waitForSelector(".msg-card", { timeout: 30000 });
    const before = s.log.requests.length;
    await s.page.click(".msg-card");
    await s.page.waitForSelector("#viewRichWrap:not(.hidden)", { timeout: 30000 });
    await L.sleep(2500);
    await shot(s.page, "03-reader-blocked");
    const opened = { requests: s.log.requests.slice(before) };
    assert.deepEqual(thirdParty(opened).map((r) => r.url), [], "no request may leave 127.0.0.1 while reading");
    assert.equal(await s.page.$eval("#viewRemoteBar", (e) => !e.classList.contains("hidden")), true, "blocked-images notice shown");
    // the message is fully readable on a phone: the frame grows with it
    const h = await s.page.$eval("#viewRichFrame", (f) => f.getBoundingClientRect().height);
    assert.ok(h > 3000, `frame height ${h}`);
    const text = await s.page.$eval("#viewRichFrame", (f) => f.contentDocument.body.textContent);
    assert.match(text, /The end\./, "the end of a long message is there");
    // nothing active survived
    const inner = await s.page.$eval("#viewRichFrame", (f) => f.contentDocument.documentElement.outerHTML);
    assert.doesNotMatch(inner, /<script|<iframe|<object|<embed|<form|<svg|onerror|javascript:|t\.invalid/i);
    // the frame can't run scripts
    assert.equal(await s.page.$eval("#viewRichFrame", (f) => f.getAttribute("sandbox").includes("allow-scripts")), false);

    const mark = s.log.requests.length;
    await s.page.click("#viewLoadImages");
    await L.sleep(2500);
    const loaded = thirdParty({ requests: s.log.requests.slice(mark) }).map((r) => r.url);
    assert.ok(loaded.some((u) => u.includes("img.invalid/hero.png")), "images load after asking: " + loaded.join(","));
    assert.deepEqual(loaded.filter((u) => NEVER.test(u)), [], "only images");

    await s.page.click("#viewFmtPlain");
    assert.match(await s.page.$eval("#viewBody", (e) => e.textContent), /Big sale \(text part\)/);
    await s.page.click("#viewBackBtn");
    await s.page.waitForFunction(() => !document.querySelector(".modal-sheet.reader"), { timeout: 5000 });
  });

  test("account screen: key fingerprint, devices, passphrase change", async () => {
    await s.page.click('.bottom-nav .nav-item[data-nav="account"]');
    await s.page.waitForSelector("#chgPassBtn", { timeout: 15000 }).catch(async () => {
      throw new Error(`no account screen: ${s.log.errors.join(" ")} | ${(await s.page.$eval("#mainView", (m) => m.innerText)).slice(0, 200)}`);
    });
    await L.sleep(800);
    await shot(s.page, "04-account");
    const fp = await s.page.$eval(".key-fp", (e) => e.textContent.trim());
    const id = L.db("mail").prepare("SELECT key_id FROM users WHERE username = ?").get(u).key_id;
    assert.equal(fp.replace(/ /g, ""), id);
    assert.ok(await s.page.$(".device-row"), "this device is listed");
    await s.page.click("#chgPassBtn");
    await type(s.page, "#chgOld", PP);
    await type(s.page, "#chgNew", "a brand new mailbox phrase");
    await type(s.page, "#chgNewConfirm", "a brand new mailbox phrase");
    await s.page.click("#chgBtn");
    await s.page.waitForFunction(() => /Passphrase changed/.test([...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" ")), { timeout: 30000 });
    assert.deepEqual(await leaks(s.log, "a brand new mailbox phrase"), []);
    assert.deepEqual(await leaks(s.log, PP), []);
  });

  test("another browser needs the passphrase; a wrong one is refused", async () => {
    const o = await openPage(URLS.mail + "/");
    await type(o.page, "#authUsername", u);
    await type(o.page, "#authPassword", PW);
    await o.page.click("#authSubmitBtn");
    await o.page.waitForSelector("#sessionUnlockForm", { timeout: 30000 });
    await shot(o.page, "05-unlock");
    await type(o.page, "#sessionPw", "not my passphrase at all");
    await o.page.click("#sessionUnlockBtn");
    await o.page.waitForFunction(() => /Wrong passphrase/.test([...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" ")), { timeout: 30000 });
    await type(o.page, "#sessionPw", "a brand new mailbox phrase");
    await submit(o.page, "#sessionUnlockForm");
    await o.page.waitForSelector("#searchInput", { timeout: 30000 });
    assert.deepEqual(await leaks(o.log, "a brand new mailbox phrase"), []);
    assert.deepEqual(await leaks(o.log, "not my passphrase at all"), []);
    assert.deepEqual(o.log.errors, []);
    await o.ctx.close();
  });

  test("no page errors", () => assert.deepEqual(s.log.errors, []));
});

describe("upgrading a format-1 mailbox in the browser", () => {
  test("refuses the sign-in password as passphrase; keeps earlier mail readable", async () => {
    const u = "old" + L.rand();
    await seedLegacy(u, "old mail before the upgrade");
    const o = await openPage(URLS.mail + "/");
    await type(o.page, "#authUsername", u);
    await type(o.page, "#authPassword", PW);
    await o.page.click("#authSubmitBtn");
    await o.page.waitForSelector("#setPassForm", { timeout: 30000 });
    await shot(o.page, "06-upgrade");
    await type(o.page, "#newPass", PW);
    await type(o.page, "#newPassConfirm", PW);
    await o.page.click("#setPassBtn");
    await o.page.waitForFunction(() => /Choose another passphrase/.test([...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" ")), { timeout: 15000 });
    assert.equal(o.log.requests.filter((r) => r.url.includes("/keys/")).length, 0, "nothing sent for a refused passphrase");
    await type(o.page, "#newPass", PP);
    await type(o.page, "#newPassConfirm", PP);
    await submit(o.page, "#setPassForm");
    await o.page.waitForSelector(".msg-card", { timeout: 60000 }).catch(async (e) => {
      throw new Error(`no inbox: ${await toastText(o.page)} | ${(await o.page.$eval("#mainView", (m) => m.innerText)).slice(0, 200)} | ${o.log.errors.join(" ")}`);
    });
    assert.equal(L.db("mail").prepare("SELECT key_format FROM users WHERE username = ?").get(u).key_format, 2);
    await o.page.click(".msg-card");
    await o.page.waitForFunction(() => /old mail before the upgrade/.test(document.querySelector("#viewBody")?.textContent || ""), { timeout: 30000 });
    assert.deepEqual(await leaks(o.log, PP), []);
    assert.deepEqual(o.log.errors, []);
    await o.ctx.close();
  });

  test("an interrupted upgrade changes nothing and can be retried", async () => {
    const u = "int" + L.rand();
    await seedLegacy(u, "still readable after a retry");
    const o = await openPage(URLS.mail + "/");
    await o.page.setRequestInterception(true);
    let cut = true;
    o.page.on("request", (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (cut && r.url().endsWith("/api/v1/keys/migrate")) { cut = false; r.abort(); } else r.continue();
    });
    await type(o.page, "#authUsername", u);
    await type(o.page, "#authPassword", PW);
    await o.page.click("#authSubmitBtn");
    await o.page.waitForSelector("#setPassForm", { timeout: 30000 });
    await type(o.page, "#newPass", PP);
    await type(o.page, "#newPassConfirm", PP);
    await o.page.click("#setPassBtn");
    await o.page.waitForFunction(() => /Upgrade failed/.test([...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" ")), { timeout: 60000 });
    assert.equal(L.db("mail").prepare("SELECT key_format FROM users WHERE username = ?").get(u).key_format, 1, "still format 1");
    await submit(o.page, "#setPassForm");
    await o.page.waitForSelector(".msg-card", { timeout: 60000 });
    await o.page.click(".msg-card");
    await o.page.waitForFunction(() => /still readable after a retry/.test(document.querySelector("#viewBody")?.textContent || ""), { timeout: 30000 });
    await o.ctx.close();
  });
});

describe("Temp in the browser", () => {
  test("opening a message contacts nobody until Load images", async () => {
    const o = await openPage(URLS.temp + "/");
    await o.page.waitForFunction(() => /@inpriv\.xyz$/.test(document.getElementById("addrValue")?.textContent || ""), { timeout: 30000 });
    const address = await o.page.$eval("#addrValue", (e) => e.textContent.trim());
    L.db("temp").prepare(`INSERT INTO messages (id, mailbox, from_addr, to_addr, subject, text, html, received_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), address, "news@shop.example", address, "Big sale", "text part", TRACKER_HTML, Date.now());
    await o.page.waitForSelector(".msg-row", { timeout: 30000 });
    const mark = o.log.requests.length;
    await o.page.click(".msg-row");
    await o.page.waitForSelector("#viewerBackdrop.open", { timeout: 15000 });
    await L.sleep(2500);
    await shot(o.page, "07-temp-reader");
    assert.deepEqual(thirdParty({ requests: o.log.requests.slice(mark) }).map((r) => r.url), []);
    assert.equal(await o.page.$eval("#vRemote", (e) => e.hidden), false);
    const mark2 = o.log.requests.length;
    await o.page.click("#vLoadImages");
    await L.sleep(2500);
    const urls = thirdParty({ requests: o.log.requests.slice(mark2) }).map((r) => r.url);
    assert.ok(urls.some((u) => u.includes("img.invalid/hero.png")), urls.join(","));
    assert.deepEqual(urls.filter((u) => NEVER.test(u)), []);
    assert.deepEqual(o.log.errors, []);
    await o.ctx.close();
  });
});
