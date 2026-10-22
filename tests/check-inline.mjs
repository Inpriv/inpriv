// The mail renderer is inlined into the Mail and Temp pages, and page sources
// are copied into each Worker's public/ by hand (AGENTS.md §3): check both.
import { readFileSync } from "node:fs";
import { ROOT } from "./lib.mjs";

const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const src = read("common/ui/mail-render.js").trimEnd();
let fails = 0;
for (const page of [".mail/index.html", ".temp/index.html"]) {
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
