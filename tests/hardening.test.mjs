// Local regression coverage for the November hardening release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from './lib.mjs';
import { protectCode, openString } from '../.id/worker/src/lib.js';
const { Client, URLS } = L;
const PW = 'release-test-password';
const ENV = { ID_ENC_KEY: 'test-only-key-0123456789abcdefgh' };

test('key replacement refuses an ID password without the current private-key proof', async () => {
  const m = await L.newMailbox('reset' + L.rand(), PW, 'old mailbox passphrase');
  const other = await L.newKey();
  const body = { password: PW, public_key: other.spki, key_id: other.id, previous_salt: m.user.priv_salt, envelope: await L.sealRing([other], other.id, 'new mailbox passphrase') };
  assert.equal((await m.mail.post('/api/v1/keys/reset', body)).status, 403);
  const challenge = (await m.mail.post('/api/v1/keys/challenge', { purpose: 'reset' })).body;
  const answer = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, m.key.priv, L.b64d(challenge.challenge));
  const proof = { challenge_id: challenge.challenge_id, challenge_answer: L.b64(answer) };
  assert.equal((await m.mail.post('/api/v1/keys/reset', { ...body, ...proof })).status, 200);
  assert.equal((await m.mail.post('/api/v1/keys/reset', { ...body, ...proof })).status, 403);
});

for (const [path, body] of [
  ['/api/2fa/disable', { password: PW }],
  ['/api/2fa/recovery/new', { password: PW }],
  ['/api/password/change', { current: PW, next: 'replacement-password' }],
  ['/api/account/delete', { password: PW }],
]) test(`${path} requires a second factor and accepts an unused recovery code`, async () => {
  const c = await L.registerId('factor' + L.rand(), PW);
  const { recovery } = await L.enable2fa(c);
  assert.equal((await c.post(path, body)).status, 401);
  assert.equal((await c.post(path, { ...body, code: 'invalid' })).status, 401);
  const r = await c.post(path, { ...body, recovery: recovery[0] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('TOTP consumption is shared by ID and Mail and rejects replay', async () => {
  const m = await L.newMailbox('replay' + L.rand(), PW, 'test mailbox passphrase');
  const c = new Client(URLS.id);
  await c.post('/api/login', { login: m.username, password: PW });
  const { secret } = await L.enable2fa(c);
  const code = L.totp(secret);
  const mail = new Client(URLS.mail);
  assert.equal((await mail.post('/api/v1/login', { username: m.username, password: PW, code })).body.status, 'ok');
  const id = new Client(URLS.id);
  const pending = (await id.post('/api/login', { login: m.username, password: PW })).body.mfa_token;
  assert.equal((await id.post('/api/login/2fa', { mfa_token: pending, code })).status, 401);
  assert.equal((await c.post('/api/2fa/disable', { password: PW, code })).status, 401);
});

test('concurrent ID sign-ins consume a recovery code only once', async () => {
  const name = 'atomic' + L.rand();
  const c = await L.registerId(name, PW);
  const { recovery } = await L.enable2fa(c);
  const clients = [new Client(URLS.id), new Client(URLS.id)];
  const pending = await Promise.all(clients.map(c => c.post('/api/login', { login: name, password: PW })));
  const results = await Promise.all(clients.map((c, i) => c.post('/api/login/2fa', { mfa_token: pending[i].body.mfa_token, recovery: recovery[0] })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
});

test('pagination reaches every message, including equal timestamps, with no duplicates', async () => {
  const m = await L.newMailbox('pages' + L.rand(), PW, 'pagination passphrase');
  const db = L.db('mail');
  const insert = db.prepare("INSERT INTO messages (owner_id, direction, peer_address, subject, encrypted_aes_key, iv, ciphertext, auth_tag, created_at) VALUES (?, 'inbound', 'sender@example.test', ?, '', '', '', '', ?)");
  for (let i = 0; i < 405; i++) insert.run(m.user.id, `Message ${i}`, 1000 + Math.floor(i / 3));
  let cursor = null;
  const ids = [];
  do {
    const r = await m.mail.get('/api/v1/messages' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length <= 200);
    ids.push(...r.body.items.map(item => item.id));
    cursor = r.body.next_cursor;
  } while (cursor);
  assert.equal(ids.length, 405);
  assert.equal(new Set(ids).size, 405);
  assert.equal((await m.mail.get('/api/v1/messages?cursor=invalid')).status, 400);
});

test('recovery-email uniqueness is enforced by SQLite, including concurrent writers', async () => {
  const a = await L.registerId('unique' + L.rand(), PW);
  const b = await L.registerId('unique' + L.rand(), PW);
  const ua = (await a.get('/api/me')).body.user;
  const ub = (await b.get('/api/me')).body.user;
  const db = L.db('id');
  const email = 'unique' + L.rand() + '@example.test';
  db.prepare('UPDATE users SET recovery_email = ? WHERE id = ?').run(email, ua.id);
  assert.throws(() => db.prepare('UPDATE users SET recovery_email = ? WHERE id = ?').run(email, ub.id), /UNIQUE/);
});

test('issued verification and recovery codes are randomized and protected at rest', async () => {
  const c = await L.registerId('protected' + L.rand(), PW);
  const { recovery } = await L.enable2fa(c);
  const uid = (await c.get('/api/me')).body.user.id;
  const hashes = L.db('id').prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ?').all(uid);
  assert.equal(hashes.length, 10);
  for (const row of hashes) assert.match(row.code_hash, /^sealed:/);
  const a = await protectCode(ENV, '123456'), b = await protectCode(ENV, '123456');
  assert.notEqual(a, b);
  assert.ok(!a.includes('123456'));
  const r = await c.post('/api/recovery-email/set', { recovery_email: 'verify' + L.rand() + '@example.test' });
  assert.equal(r.status, 200);
  const code = L.db('id').prepare('SELECT code_hash FROM email_codes WHERE user_id = ?').get(uid).code_hash;
  assert.match(code, /^sealed:/);
  assert.equal((await c.post('/api/2fa/recovery/new', { password: PW, recovery: recovery[0] })).status, 200);
});

test('deleting an account deletes both security logs', async () => {
  const name = 'logs' + L.rand();
  const c = await L.registerId(name, PW);
  const uid = (await c.get('/api/me')).body.user.id;
  await L.sleep(100);
  const db = L.db('id');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM auth_events WHERE user_id = ?').get(uid).n > 0);
  assert.equal((await c.post('/api/account/delete', { password: PW })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM auth_events WHERE user_id = ?').get(uid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM access_log WHERE account = ?').get(name).n, 0);
});

test('Temp creation counters retain only a network prefix and taken names return generated inboxes', async () => {
  const c = new Client(URLS.temp, { ip: '203.0.113.79' });
  const r = await c.post('/api/mailbox', { local: 'support' });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.address, 'support@inpriv.xyz');
  const rows = L.db('id').prepare("SELECT k FROM rl_counters WHERE k LIKE 'temp%203.0.113%'").all();
  assert.ok(rows.length);
  assert.ok(rows.every(r => !r.k.includes('113.79') && r.k.includes('203.0.113.0/24')));
});

test('public state strips operator text and restricts browser origins', async () => {
  for (const origin of ['https://evil.example', 'https://mail.inpriv.xyz']) {
    const r = await fetch(URLS.admin + '/public/state', { headers: { Origin: origin } });
    assert.equal(r.headers.get('access-control-allow-origin'), origin.endsWith('mail.inpriv.xyz') ? origin : null);
    const body = await r.json();
    assert.ok(!('message' in body.global));
    assert.ok(!('message' in body.info));
  }
});

test('authenticated ID reads write last_used no more than once per five minutes', async () => {
  const c = await L.registerId('throttle' + L.rand(), PW);
  const uid = (await c.get('/api/me')).body.user.id;
  const before = L.db('id').prepare('SELECT last_used FROM sessions WHERE user_id = ?').get(uid).last_used;
  await c.get('/api/public/me');
  assert.equal(L.db('id').prepare('SELECT last_used FROM sessions WHERE user_id = ?').get(uid).last_used, before);
});

test('legacy recovery hashes are protected without changing an issued recovery code', async () => {
  const c = await L.registerId('legacycode' + L.rand(), PW);
  const { recovery } = await L.enable2fa(c);
  const uid = (await c.get('/api/me')).body.user.id;
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(recovery[0].toLowerCase()))).toString('hex');
  const db = L.db('id');
  const row = db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? LIMIT 1').get(uid);
  db.prepare('UPDATE recovery_codes SET code_hash = ? WHERE id = ?').run(hash, row.id);
  assert.equal((await c.get('/api/health')).status, 200);
  assert.match(db.prepare('SELECT code_hash FROM recovery_codes WHERE id = ?').get(row.id).code_hash, /^legacy-sealed:/);
  assert.equal((await c.post('/api/2fa/disable', { password: PW, recovery: recovery[0] })).status, 200);
});

test('external sending requires a confirmed recovery email', async () => {
  const m = await L.newMailbox('external' + L.rand(), PW, 'external test passphrase');
  const r = await m.mail.post('/api/v1/messages/send', { mode: 'external', to: 'recipient@example.test', sender_key_id: m.key.id });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /confirm your recovery email/i);
});

test('registration has the same response for held and free recovery addresses', async () => {
  const owner = await L.registerId('quartz' + L.rand(), PW);
  const uid = (await owner.get('/api/me')).body.user.id;
  const taken = 'held' + L.rand() + '@example.test';
  L.db('id').prepare('UPDATE users SET recovery_email = ?, recovery_email_verified = 1 WHERE id = ?').run(taken, uid);
  const results = [];
  for (const address of [taken, 'free' + L.rand() + '@example.test']) {
    const c = new Client(URLS.id);
    const r = await c.post('/api/register', { username: 'pebble' + L.rand(), password: PW, recovery_email: address });
    assert.equal(r.status, 200);
    assert.equal((await c.get('/api/me')).body.user.recovery_email, address);
    results.push([r.body.verification_sent, Object.keys(r.body).sort(), Object.keys(r.body.user).sort()]);
  }
  assert.deepEqual(results[0], results[1]);
});

test('verification emails are capped per destination across different accounts', async () => {
  const address = 'cap' + L.rand() + '@example.test';
  let last;
  for (let i = 0; i < 4; i++) {
    const c = await L.registerId('captest' + L.rand(), PW);
    last = await c.post('/api/recovery-email/set', { recovery_email: address });
    if (i < 3) assert.equal(last.body.code_sent, true);
  }
  assert.equal(last.body.code_sent, false);
  assert.match(last.body.error, /too many emails/i);
});

test('verification binds only the current address and only the latest code works', async () => {
  const c = await L.registerId('verifyflow' + L.rand(), PW);
  const address = 'confirm' + L.rand() + '@example.test';
  const codes = () => [...readFileSync(new URL('../.wrangler/logs/8798.log', import.meta.url), 'utf8').matchAll(new RegExp('to=' + address.replaceAll('.', '\\.') + ' subject=(\\d{6})', 'g'))].map(m => m[1]);
  assert.equal((await c.post('/api/recovery-email/set', { recovery_email: address })).body.code_sent, true);
  const first = codes().at(-1);
  assert.match(first, /^\d{6}$/);
  assert.equal((await c.post('/api/verify/send', {})).status, 200);
  for (let i = 0; i < 20 && codes().length < 2; i++) await L.sleep(50);
  assert.equal(codes().length, 2, 'both test emails reached the local log');
  const second = codes().at(-1);
  if (first !== second) assert.equal((await c.post('/api/verify/confirm', { code: first })).status, 401);
  const result = await c.post('/api/verify/confirm', { code: second });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.recovery_email_verified, true);
  assert.equal((await c.post('/api/verify/confirm', { code: second })).status, 401);
});

test('the local status Worker serves its API using local storage', async () => {
  const res = await fetch('http://127.0.0.1:8793/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).release, '2026-11-08');
  const status = await fetch('http://127.0.0.1:8793/api/status');
  assert.equal(status.status, 200);
});
