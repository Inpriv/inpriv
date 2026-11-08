import { test } from 'node:test';
import assert from 'node:assert/strict';
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
