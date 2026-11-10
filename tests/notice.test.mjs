// The admin notice and the lock message must actually reach the pages. They
// used to be stripped in /public/state (info hardcoded inactive, message
// dropped by flags()), so the operator's words never appeared anywhere.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client, URLS, rand, sleep, db } from "./lib.mjs";

const admin = db("id");
const landing = new Client(URLS.landing);

const NOTICE = `Notice ${rand(6)} <b>stays text</b>`;
const LOCK = `Lock ${rand(6)}`;

function writeState(state) {
  admin.prepare("INSERT INTO admin_kv (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(JSON.stringify(state));
}

async function until(check, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    // the admin caches for 3 s, the edge for 2 s, and a stale copy may be
    // served for up to 30 s while it revalidates — so allow for that
    await sleep(500);
  }
  throw new Error("timed out waiting for " + label);
}

after(() => writeState({
  global: { locked: false, message: "", ts: 0 },
  info: { active: false, message: "", ts: 0 },
  services: {},
  audit: [],
}));

test("a notice set in admin reaches the banner endpoint, text and all", async () => {
  writeState({
    global: { locked: false, message: "", ts: 0 },
    info: { active: true, message: NOTICE, ts: Date.now() },
    services: {},
    audit: [],
  });

  await until(async () => {
    const r = await landing.get("/api/maintenance");
    return r.body && r.body.info === NOTICE;
  }, "the notice");

  // every site answers the same thing, on its own path (each keeps its own
  // gate cache, so give the stale copy time to expire)
  const paths = [[URLS.mail, "/api/v1/maintenance"], [URLS.id, "/api/maintenance"], [URLS.temp, "/api/maintenance"]];
  for (const [base, path] of paths) {
    await until(async () => {
      const r = await new Client(base).get(path);
      return r.body && r.body.info === NOTICE;
    }, base + path, 120);
  }
});

test("the lock message is published, so the maintenance page shows it", async () => {
  writeState({
    global: { locked: true, message: LOCK, ts: Date.now() },
    info: { active: false, message: "", ts: 0 },
    services: {},
    audit: [],
  });

  for (const base of [URLS.landing, URLS.mail, URLS.temp, URLS.id]) {
    await until(async () => {
      const r = await new Client(base).get("/", { raw: true });
      const html = await r.text();
      return r.status === 503 && html.includes(LOCK);
    }, "the lock message on " + base, 120);
  }
});
