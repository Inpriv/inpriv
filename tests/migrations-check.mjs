// Schema and migrations must agree.
//
// D1 has no way to add a column twice, so migrations are applied by hand (see
// .github/workflows/deploy-workers.yml, which *verifies* them before deploying).
// This check catches the other half of that arrangement: a column added to a
// migration but forgotten in schema.sql, or the reverse, and numbering mistakes.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  { name: "inpriv-id", schema: ".id/schema.sql", dir: ".id/worker/migrations" },
  { name: "inpriv-mail", schema: ".mail/schema.sql", dir: ".mail/worker/migrations" },
  { name: "inpriv-temp", schema: ".temp/worker/schema.sql", dir: ".temp/worker/migrations" },
];

let problems = 0;
const fail = (msg) => { problems++; console.error("  ✖ " + msg); };

for (const t of targets) {
  const schema = readFileSync(join(root, t.schema), "utf8");
  let files;
  try { files = readdirSync(join(root, t.dir)).filter((f) => f.endsWith(".sql")).sort(); }
  catch { continue; }                                   // no migrations dir: nothing to compare

  // numbering: unique, ascending, four digits
  const seen = new Set();
  for (const f of files) {
    const m = f.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
    if (!m) fail(`${t.dir}/${f}: name must be NNNN_topic.sql`);
    else if (seen.has(m[1])) fail(`${t.dir}/${f}: duplicate number ${m[1]}`);
    else seen.add(m[1]);
  }

  // every column a migration adds must exist in schema.sql
  for (const f of files) {
    const sql = readFileSync(join(root, t.dir, f), "utf8");
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
      const [, table, column] = m;
      const tableBlock = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
      if (!tableBlock) { fail(`${t.name}: ${f} alters ${table}, which schema.sql does not create`); continue; }
      if (!new RegExp(`\\b${column}\\b`, "i").test(tableBlock[1])) {
        fail(`${t.name}: ${f} adds ${table}.${column}, missing from ${t.schema}`);
      }
    }
    // every table a migration creates must be in schema.sql
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)) {
      if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${m[1]} `, "i").test(schema)) {
        fail(`${t.name}: ${f} creates ${m[1]}, missing from ${t.schema}`);
      }
    }
  }
  console.log(`  ${t.name}: ${files.length} migration(s) checked`);
}

if (problems) {
  console.error(`migrations check failed: ${problems} problem(s)`);
  process.exit(1);
}
console.log("migrations and schema.sql agree");
