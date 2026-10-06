// Copies the Inpriv UI core (inpriv-ui.css / inpriv-ui.js) into every page
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
if (check && stale) process.exit(1);
