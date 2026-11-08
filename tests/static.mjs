// Parse tracked JavaScript and every inline page script without executing it.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let count = 0;
for (const file of files) {
  const sources = /\.(m?js|cjs)$/.test(file) ? [readFileSync(file, 'utf8')] : /\.html$/.test(file) ? [...readFileSync(file, 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/src=|ld\+json|application\/json/i.test(m[1])).map(m => m[2]) : [];
  for (const source of sources) {
    const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: source, encoding: 'utf8' });
    if (result.status) { console.error(file, result.stderr); process.exit(1); }
    count++;
  }
}
console.log(`${count} JavaScript sources parsed`);
