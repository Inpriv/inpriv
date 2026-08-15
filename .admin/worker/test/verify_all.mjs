// Comprehensive test for all 15 inpriv services + admin kill-switch + English UI
import fs from "node:fs/promises";
import crypto from "node:crypto";

const BASE_ADMIN = "https://admin.inpriv.xyz";
const SERVICES = [
  { id: "landing", url: "https://inpriv.xyz", titleMatch: /Inpriv/i },
  { id: "temp", url: "https://temp.inpriv.xyz", titleMatch: /Temp/i },
  { id: "burn", url: "https://burn.inpriv.xyz", titleMatch: /Burn/i },
  { id: "qr", url: "https://qr.inpriv.xyz", titleMatch: /QR/i },
  { id: "stego", url: "https://stego.inpriv.xyz", titleMatch: /Stego/i },
  { id: "brute", url: "https://brute.inpriv.xyz", titleMatch: /Brute|Pass/i },
  { id: "compress", url: "https://compress.inpriv.xyz", titleMatch: /Compress/i },
  { id: "dns", url: "https://dns.inpriv.xyz", titleMatch: /DNS/i },
  { id: "hash", url: "https://hash.inpriv.xyz", titleMatch: /Hash/i },
  { id: "ipinfo", url: "https://ipinfo.inpriv.xyz", titleMatch: /IP/i },
  { id: "keyring", url: "https://keyring.inpriv.xyz", titleMatch: /Keyring/i },
  { id: "pay", url: "https://pay.inpriv.xyz", titleMatch: /Pay/i },
  { id: "totp", url: "https://totp.inpriv.xyz", titleMatch: /TOTP|2FA/i },
  { id: "webrtc", url: "https://webrtc.inpriv.xyz", titleMatch: /WebRTC/i },
  { id: "wipe", url: "https://wipe.inpriv.xyz", titleMatch: /Wipe|Metadata/i },
];

function generateTOTP(secretBase32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.toUpperCase().replace(/=/g, "")) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

let cookie = "";
async function adminReq(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE_ADMIN}${path}`, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}

async function run() {
  const secretPath = process.argv[2] || "C:/Users/mckkw/Desktop/Private/.projects/.APIs/inpriv-admin-totp.key";
  const secret = (await fs.readFile(secretPath, "utf-8")).trim();
  console.log("== 1. VERIFYING ALL 15 SERVICES OPERATIONAL (NORMAL STATE) ==");
  for (const svc of SERVICES) {
    const res = await fetch(svc.url, { cache: "no-store" });
    const text = await res.text();
    const ok = res.status === 200 && (!svc.titleMatch || svc.titleMatch.test(text));
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${svc.id.padEnd(10)} -> HTTP ${res.status} (length: ${text.length})`);
    if (!ok) throw new Error(`Service ${svc.id} failed basic operational check`);
  }

  console.log("\n== 2. ADMIN AUTH & LOGIN ==");
  const code = generateTOTP(secret);
  const loginRes = await adminReq("/api/login", {
    method: "POST",
    body: JSON.stringify({ user: "saloyek", code }),
  });
  console.log(`  Login status: HTTP ${loginRes.status}`);
  if (loginRes.status !== 200) throw new Error("Admin login failed");

  console.log("\n== 3. TESTING GLOBAL KILL-SWITCH ==");
  const lockMsg = "Global Emergency Maintenance Test";
  const lockRes = await adminReq("/api/global", {
    method: "POST",
    body: JSON.stringify({ locked: true, message: lockMsg }),
  });
  console.log(`  Lock trigger status: HTTP ${lockRes.status}`);

  console.log("  Waiting 5s for edge cache propagation...");
  await new Promise((r) => setTimeout(r, 5000));

  let allLocked = true;
  for (const svc of SERVICES) {
    const res = await fetch(svc.url, { cache: "no-store" });
    const text = await res.text();
    const isLocked = res.status === 503 && text.includes(lockMsg) && text.includes("temporarily unavailable");
    console.log(`  [${isLocked ? "LOCKED" : "UNLOCKED"}] ${svc.id.padEnd(10)} -> HTTP ${res.status}`);
    if (!isLocked) allLocked = false;
  }
  console.log(`  Global kill-switch verification: ${allLocked ? "ALL 15 SERVICES LOCKED SUCCESSFULLY" : "SOME SERVICES NOT LOCKED"}`);
  if (!allLocked) throw new Error("Global kill switch failed to lock all services");

  console.log("\n== 4. TESTING GLOBAL UNLOCK ==");
  const unlockRes = await adminReq("/api/global", {
    method: "POST",
    body: JSON.stringify({ locked: false, message: "" }),
  });
  console.log(`  Unlock trigger status: HTTP ${unlockRes.status}`);

  console.log("  Waiting 5s for edge cache propagation...");
  await new Promise((r) => setTimeout(r, 5000));

  let allRestored = true;
  for (const svc of SERVICES) {
    const res = await fetch(svc.url, { cache: "no-store" });
    const isOk = res.status === 200;
    console.log(`  [${isOk ? "RESTORED" : "FAIL"}] ${svc.id.padEnd(10)} -> HTTP ${res.status}`);
    if (!isOk) allRestored = false;
  }
  console.log(`  Global unlock verification: ${allRestored ? "ALL 15 SERVICES RESTORED TO 200 OK" : "SOME SERVICES NOT RESTORED"}`);
  if (!allRestored) throw new Error("Global unlock failed");

  console.log("\n== ALL TESTS PASSED SUCCESSFULLY! 15/15 SERVICES FULLY GATED & WORKING ==");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
