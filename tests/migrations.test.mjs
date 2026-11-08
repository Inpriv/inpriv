import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

for (const service of ['id', 'mail', 'temp', 'status']) test(`${service} migrations build an intact schema matching the bootstrap schema`, () => {
  const db = new DatabaseSync(':memory:');
  const schema = new DatabaseSync(':memory:');
  try {
    const folder = new URL(`../.${service}/worker/migrations/`, import.meta.url);
    for (const file of readdirSync(folder).sort()) db.exec(readFileSync(new URL(file, folder), 'utf8'));
    const source = new URL(service === 'temp' ? '../.temp/worker/schema.sql' : `../.${service}/schema.sql`, import.meta.url);
    schema.exec(readFileSync(source, 'utf8'));
    schema.exec(readFileSync(source, 'utf8'));
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of names) {
      const columns = d => d.prepare(`PRAGMA table_info(${name})`).all().map(c => [c.name, c.type]).sort();
      assert.deepEqual(columns(db), columns(schema), name);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    if (service === 'mail') {
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id, created_at FROM messages WHERE owner_id = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 201').all(1, 1000, 100);
      assert.ok(plan.some(r => r.detail.includes('idx_messages_owner_created')));
      assert.ok(plan.every(r => !r.detail.includes('TEMP B-TREE')));
    }
  } finally { db.close(); schema.close(); }
});
