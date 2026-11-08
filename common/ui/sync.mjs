// Copies every shared UI module into its pages
// and mirrors each source page into the folder its Worker serves.
//
//   node common/ui/sync.mjs          write
//   node common/ui/sync.mjs --check  exit 1 when anything is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const css = readFileSync(join(here, "inpriv-ui.css"), "utf8").trim();
const js = readFileSync(join(here, "inpriv-ui.js"), "utf8").trim();

// [source page, copy served by the Worker (or null)]
const PAGES = [
  ["index.html", "worker/public/index.html"],
  [".mail/index.html", ".mail/worker/public/index.html"],
  [".temp/index.html", ".temp/worker/public/index.html"],
  [".id/worker/public/index.html", null],
  [".admin/worker/public/index.html", null],
  [".status/worker/public/index.html", null],
];

const check = process.argv.includes("--check");
let stale = 0;

function fill(html, open, close, body, file) {
  const a = html.indexOf(open);
  if (a < 0) throw new Error(`${file}: missing ${open}`);
  const b = html.indexOf(close, a + open.length);
  if (b < 0) throw new Error(`${file}: unterminated ${open}`);
  return html.slice(0, a + open.length) + "\n" + body + "\n" + html.slice(b);
}

for (const [src, copy] of PAGES) {
  const path = join(repo, src);
  const before = readFileSync(path, "utf8");
  let html = fill(before, '<style id="inpriv-ui">', "</style>", css, src);
  html = fill(html, '<script id="inpriv-ui-js">', "</script>", js, src);
  for (const [tag, id, module] of [
    ['script', 'inpriv-pwa', 'pwa.js'], ['script', 'inpriv-mail-render', 'mail-render.js'],
    ['script', 'inpriv-mail-unsubscribe', 'mail-unsubscribe.js'],
    ['script', 'inpriv-mode-switch', 'mode-switch.js'], ['style', 'inpriv-mode-switch-css', 'mode-switch.css'],
  ]) {
    const open = `<${tag} id="${id}">`;
    if (html.includes(open)) html = fill(html, open, `</${tag}>`, readFileSync(join(here, module), 'utf8').trimEnd(), src);
  }
  const targets = [[path, before]];
  if (copy) {
    const cp = join(repo, copy);
    let old = "";
    try { old = readFileSync(cp, "utf8"); } catch {}
    targets.push([cp, old]);
  }
  for (const [file, old] of targets) {
    if (old === html) continue;
    stale++;
    if (check) console.log("out of date:", file.slice(repo.length + 1));
    else { writeFileSync(file, html); console.log("wrote", file.slice(repo.length + 1)); }
  }
}
for (const file of ['worker/public/offline.html', '.mail/worker/public/offline.html', '.temp/worker/public/offline.html']) {
  const path = join(repo, file);
  const old = readFileSync(path, 'utf8');
  const html = fill(old, '<script id="inpriv-pwa">', '</script>', readFileSync(join(here, 'pwa.js'), 'utf8').trimEnd(), file);
  if (html !== old) { stale++; if (check) console.log('out of date:', file); else writeFileSync(path, html); }
}
for (const file of ['sw.js', 'worker/public/sw.js', '.mail/worker/public/sw.js', '.temp/worker/public/sw.js']) {
  const path = join(repo, file);
  const old = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const source = readFileSync(join(here, 'pwa-sw.js'), 'utf8');
  if (old.trimEnd() !== source.trimEnd()) { stale++; if (check) console.log('out of date:', file); else writeFileSync(path, source); }
}
if (check && stale) process.exit(1);
