// The admin notice and the lock message must actually reach the pages. They
// used to be stripped in /public/state (info hardcoded inactive, message
// dropped by flags()), so the operator's words never appeared anywhere.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client, URLS, rand, sleep, db, newMailbox } from "./lib.mjs";

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
  }, "the notice", 220);

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
    }, "the lock message on " + base, 220);
  }

  // unlock again: the next test needs a working stack
  writeState({
    global: { locked: false, message: "", ts: 0 },
    info: { active: false, message: "", ts: 0 },
    services: {},
    audit: [],
  });
  await until(async () => {
    const r = await new Client(URLS.id).get("/", { raw: true });
    return r.status === 200;
  }, "the site to unlock", 220);
});

test('external sending needs a confirmed recovery email only when the policy requires it', async () => {
  const m = await newMailbox('external' + rand(), "test-password-123", 'external test passphrase');
  const send = () => m.mail.post('/api/v1/messages/send', { mode: 'external', to: 'recipient@example.test', sender_key_id: m.key.id });
  const published = async (allow) => {
    const r = await new Client(URLS.admin).get('/public/state');
    return !!(r.body && r.body.settings && r.body.settings.allowExternalWithoutRecovery === allow);
  };
  const setPolicy = (allow) => db('id').prepare(
    "UPDATE admin_kv SET v = json_set(v, '$.settings.allowExternalWithoutRecovery', json(?)) WHERE k='state'"
  ).run(allow ? 'true' : 'false');

  // Default: allowed. (Locally the relay is not configured, so this answers
  // 503 — what matters is that it is not the recovery gate refusing it.)
  assert.notEqual((await send()).status, 403);

  // The operator turns the requirement back on.
  setPolicy(false);
  await until(() => published(false), 'the policy to be published', 120);
  await sleep(4000); // the Mail worker keeps its own gate copy for a moment
  const refused = await send();
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /confirm your recovery email/i);

  // and back off again, so the local stack matches the code default
  setPolicy(true);
  await until(() => published(true), 'the default policy', 120);
});
