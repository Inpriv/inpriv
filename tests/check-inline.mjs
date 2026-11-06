// The mail renderer is inlined into the Mail and Temp pages, and page sources
// are copied into each Worker's public/ by hand (AGENTS.md §3): check both.
import { readFileSync } from "node:fs";
import { ROOT } from "./lib.mjs";

const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const src = read("common/ui/mail-render.js").trimEnd();
let fails = 0;
const unsubscribe = read('.mail/index.html').match(/<script id="inpriv-mail-unsubscribe">\n([\s\S]*?)\n<\/script>/);
const unsubscribeMatches = !!unsubscribe && unsubscribe[1] === read('common/ui/mail-unsubscribe.js').trimEnd();
console.log(`${unsubscribeMatches ? 'ok  ' : 'FAIL'} Mail: inlined unsubscribe helper matches`);
if (!unsubscribeMatches) fails++;
for (const page of ['index.html', '.mail/index.html', '.temp/index.html', 'worker/public/offline.html', '.mail/worker/public/offline.html', '.temp/worker/public/offline.html']) {
  const block = read(page).match(/<script id="inpriv-pwa">\n([\s\S]*?)\n<\/script>/);
  const ok = !!block && block[1] === read('common/ui/pwa.js').trimEnd();
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${page}: PWA startup matches`);
  if (!ok) fails++;
}
for (const file of ['sw.js', 'worker/public/sw.js', '.mail/worker/public/sw.js', '.temp/worker/public/sw.js']) {
  const ok = read(file).replace(/\r\n/g, '\n').trimEnd() === read('common/ui/pwa-sw.js').trimEnd();
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: public-only service worker matches`);
  if (!ok) fails++;
}
for (const page of [".mail/index.html", ".temp/index.html"]) {
  for (const [tag, id, file] of [['script', 'inpriv-mode-switch', 'mode-switch.js'], ['style', 'inpriv-mode-switch-css', 'mode-switch.css']]) {
    const block = read(page).match(new RegExp('<' + tag + ' id="' + id + '">\\n([\\s\\S]*?)\\n</' + tag + '>'));
    const matches = !!block && block[1] === read('common/ui/' + file).trimEnd();
    console.log(`${matches ? 'ok  ' : 'FAIL'} ${page}: inlined ${file} matches`);
    if (!matches) fails++;
  }
  const m = read(page).match(/<script id="inpriv-mail-render">\n([\s\S]*?)\n<\/script>/);
  const ok = !!m && m[1] === src;
  console.log(`${ok ? "ok  " : "FAIL"} ${page}: inlined renderer matches common/ui/mail-render.js`);
  if (!ok) fails++;
}
for (const [a, b] of [["index.html", "worker/public/index.html"], [".mail/index.html", ".mail/worker/public/index.html"], [".temp/index.html", ".temp/worker/public/index.html"]]) {
  const ok = read(a) === read(b);
  console.log(`${ok ? "ok  " : "FAIL"} ${b} is a copy of ${a}`);
  if (!ok) fails++;
}
process.exit(fails ? 1 : 0);
