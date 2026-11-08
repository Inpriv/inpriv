import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { relayBudget } from '../common/relay-budget.js';
import { rateLimit } from '../common/rate-limit.js';
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE rl_counters (k TEXT, bucket INTEGER, c INTEGER, exp INTEGER, PRIMARY KEY(k,bucket))');
  return {
    sqlite,
    prepare: sql => ({ bind: (...args) => ({ first: async () => sqlite.prepare(sql).get(...args) }) }),
  };
}
test('concurrent increments have a single atomic budget and explicit error policy', async () => {
  const db = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit(db, 'test', 3, 3600000)));
    assert.equal(results.filter(Boolean).length, 3);
    const broken = { prepare: () => { throw new Error('unavailable'); } };
    await assert.rejects(rateLimit(broken, 'test', 3, 3600000));
    assert.equal(await rateLimit(broken, 'test', 3, 3600000, { failOpen: true }), true);
  } finally { db.sqlite.close(); }
});
test('operator and account mail share global and per-recipient relay budgets', async () => {
  const db = fixture();
  try {
    for (let i = 0; i < 10; i++) assert.equal(await relayBudget(db, i % 2 ? 'team:support' : 'user:1', 'same@example.test'), true);
    assert.equal(await relayBudget(db, 'user:2', 'same@example.test'), false);
    db.sqlite.prepare('UPDATE rl_counters SET c = 500 WHERE k = ?').run('relay:global:day');
    assert.equal(await relayBudget(db, 'team:abuse', 'other@example.test'), false);
    assert.ok(!JSON.stringify(db.sqlite.prepare('SELECT * FROM rl_counters').all()).includes('@example.test'));
  } finally { db.sqlite.close(); }
});
