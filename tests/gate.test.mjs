import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../common/gate.js';
test('a stale lock survives unreachable, HTTP-error and malformed admin responses', async () => {
  const original = globalThis.fetch, clock = Date.now;
  let time = 10000;
  Date.now = () => time;
  try {
    const { maintenanceGate } = await import('../common/gate.js?locked-test');
    globalThis.fetch = async () => Response.json({ global: { locked: true }, services: {} });
    assert.equal((await maintenanceGate('mail')).locked, true);
    for (const response of [() => { throw new Error('offline'); }, () => new Response('failure', { status: 500 }), () => Response.json({})]) {
      time += 4000; globalThis.fetch = response;
      assert.equal((await maintenanceGate('mail')).locked, true);
    }
    time += 4000; globalThis.fetch = async () => Response.json({ global: { locked: false }, services: {} });
    assert.equal((await maintenanceGate('mail')).locked, false);
  } finally { globalThis.fetch = original; Date.now = clock; }
});

// The sending policy travels with the gate, so this projection is what Mail
// acts on. Both directions, without any cache in the way.
test('the sending policy projects both ways, and defaults to allowed', () => {
  const base = { global: { locked: false, message: '', ts: 0 }, info: { active: false }, services: {} };

  // no settings at all (an older state row): keep the historical behaviour
  assert.equal(project(base, 'mail').settings.allowExternalWithoutRecovery, true);

  const allowed = { ...base, settings: { allowExternalWithoutRecovery: true } };
  assert.equal(project(allowed, 'mail').settings.allowExternalWithoutRecovery, true);

  const required = { ...base, settings: { allowExternalWithoutRecovery: false } };
  assert.equal(project(required, 'mail').settings.allowExternalWithoutRecovery, false);

  // the gate itself still locks independently of the policy
  const locked = { ...base, global: { locked: true, message: 'down', ts: 0 }, settings: { allowExternalWithoutRecovery: false } };
  assert.equal(project(locked, 'mail').locked, true);
  assert.equal(project(locked, 'mail').message, 'down');
});
