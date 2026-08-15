// E2E admin dashboard: TOTP login → kill-switches → rate limit.
// Usage: node test/e2e.mjs <totp-secret-file>
import fs from "node:fs/promises";
import crypto from "node:crypto";

const BASE = "https://admin.inpriv.xyz";
const secret = (await fs.readFile(process.argv[2], "utf8")).trim();

// TOTP code for "now" (same algorithm as Google Authenticator)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32dec(s) {
  s = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of s) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
async function totp(offset = 0) {
  const key = b32dec(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf));
  const o = mac[19] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1e6).padStart(6, "0");
}

let cookies = "";
async function call(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookies ? { Cookie: cookies } : {}), ...(opts.headers || {}) },
  });
  const setc = res.headers.get("set-cookie");
  if (setc && setc.includes("inpriv_admin=")) cookies = setc.split(";")[0];
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`); if (!cond) process.exitCode = 1; };

// 1. public state
let r = await call("/public/state");
ok("public state 200", r.status === 200 && r.body.services && "temp" in r.body.services);

// 2. login: wrong user rejected
r = await call("/api/login", { method: "POST", body: JSON.stringify({ user: "hacker", code: await totp() }) });
ok("wrong nick → 401", r.status === 401);

// 3. login: wrong code rejected
r = await call("/api/login", { method: "POST", body: JSON.stringify({ user: "saloyek", code: "000001" }) });
ok("wrong code → 401", r.status === 401);

// 4. login: correct TOTP → session cookie
r = await call("/api/login", { method: "POST", body: JSON.stringify({ user: "saloyek", code: await totp() }) });
ok("TOTP login → 200 + cookie", r.status === 200 && cookies.includes("inpriv_admin="));

// 5. /api/me
r = await call("/api/me");
ok("session works (/api/me)", r.status === 200 && r.body.user === "saloyek");

// 6. unauthenticated state rejected
const noAuth = await fetch(`${BASE}/api/state`);
ok("no cookie /api/state → 401", noAuth.status === 401);

// 7. lock temp service
r = await call("/api/service", { method: "POST", body: JSON.stringify({ service: "temp", locked: true, message: "Testowa blokada E2E" }) });
ok("lock temp → 200", r.status === 200);
await new Promise((s) => setTimeout(s, 2000));
let tempRes = await fetch("https://temp.inpriv.xyz/api/mailbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok("temp API locked → 503", tempRes.status === 503);
const tempHtml = await (await fetch("https://temp.inpriv.xyz/")).text();
ok("temp page shows maintenance", tempHtml.includes("tymczasowo niedostępne") && tempHtml.includes("Testowa blokada E2E"));

// 8. unlock temp
r = await call("/api/service", { method: "POST", body: JSON.stringify({ service: "temp", locked: false, message: "" }) });
ok("unlock temp → 200", r.status === 200);
await new Promise((s) => setTimeout(s, 12000));
tempRes = await fetch("https://temp.inpriv.xyz/api/mailbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok("temp API unlocked → 201", tempRes.status === 201);
if (tempRes.status === 201) {
  const mb = await tempRes.json();
  await fetch("https://temp.inpriv.xyz/api/mailbox", { method: "DELETE", headers: { Authorization: `Bearer ${mb.token}` } });
}

// 9. global info banner
r = await call("/api/info", { method: "POST", body: JSON.stringify({ active: true, message: "Testowy banner E2E" }) });
ok("info on → 200", r.status === 200);
await new Promise((s) => setTimeout(s, 8000));
const maint = await (await fetch("https://temp.inpriv.xyz/api/maintenance")).json();
ok("temp /api/maintenance shows info", maint.info === "Testowy banner E2E");
r = await call("/api/info", { method: "POST", body: JSON.stringify({ active: false, message: "" }) });
ok("info off → 200", r.status === 200);

// 10. global lock
r = await call("/api/global", { method: "POST", body: JSON.stringify({ locked: true, message: "Globalna blokada E2E" }) });
ok("global lock → 200", r.status === 200);
await new Promise((s) => setTimeout(s, 2500));
tempRes = await fetch("https://temp.inpriv.xyz/api/mailbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok("global lock → temp 503", tempRes.status === 503);
const health = await fetch("https://temp.inpriv.xyz/api/health");
ok("health exempt during lock", health.status === 200);
r = await call("/api/global", { method: "POST", body: JSON.stringify({ locked: false, message: "" }) });
ok("global unlock → 200", r.status === 200);
await new Promise((s) => setTimeout(s, 12000));
tempRes = await fetch("https://temp.inpriv.xyz/api/mailbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok("after global unlock → 201", tempRes.status === 201);
if (tempRes.status === 201) {
  const mb = await tempRes.json();
  await fetch("https://temp.inpriv.xyz/api/mailbox", { method: "DELETE", headers: { Authorization: `Bearer ${mb.token}` } });
}

// 11. audit trail
r = await call("/api/state");
ok("audit recorded", (r.body.audit || []).some((a) => a.action === "global_lock"));

// 12. logout → session dead, then fresh login works
r = await call("/api/logout", { method: "POST" });
ok("logout → 200", r.status === 200);
r = await call("/api/me");
ok("session invalid after logout", r.status === 401);
r = await call("/api/login", { method: "POST", body: JSON.stringify({ user: "saloyek", code: await totp() }) });
ok("fresh login after logout", r.status === 200);
await call("/api/logout", { method: "POST" });
cookies = "";

// 13. rate limit (10 fails / 5 min → 429; cleanup needed after: delete rl:<ip> in KV)
let got429 = false;
for (let i = 0; i < 12; i++) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "saloyek", code: "999999" }),
  });
  if (res.status === 429) { got429 = true; break; }
}
ok("rate limit kicks in (429)", got429);
console.log("note: rl:<ip> block is active now — clean with wrangler kv key delete");

console.log(process.exitCode ? "\nE2E FAILED" : "\nE2E ALL OK");
