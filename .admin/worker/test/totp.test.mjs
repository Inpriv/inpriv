// HOTP/TOTP tests: RFC 4226 Appendix D vectors (6-digit, SHA-1) — the same
// algorithm Google Authenticator uses (TOTP = HOTP over time steps).
import { hotp, verifyTOTP, base32Decode } from "../src/index.js";
import crypto from "node:crypto";

const RFC_KEY = Buffer.from("12345678901234567890");
const VECTORS = [
  [0, "755224"], [1, "287082"], [2, "359152"], [3, "969429"],
  [4, "338314"], [5, "254676"], [6, "287922"], [7, "162583"],
  [8, "399871"], [9, "520489"],
];

let fails = 0;
for (const [counter, expect] of VECTORS) {
  const got = await hotp(new Uint8Array(RFC_KEY), counter); // 6 digits
  const pass = got === expect;
  console.log(`counter ${counter}: expect ${expect}, got ${got} → ${pass ? "OK" : "FAIL"}`);
  if (!pass) fails++;
}

// base32 roundtrip (Google Authenticator secret format: 20 bytes → 32 chars)
const raw = crypto.randomBytes(20);
const B32A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let enc = "", v = 0, n = 0;
for (const byte of raw) {
  v = (v << 8) | byte; n += 8;
  while (n >= 5) { enc += B32A[(v >>> (n - 5)) & 31]; n -= 5; }
}
if (n) enc += B32A[(v << (5 - n)) & 31];
const same = Buffer.from(base32Decode(enc)).equals(raw);
console.log("base32 roundtrip:", same ? "OK" : "FAIL");
if (!same) fails++;

// verifyTOTP: current step code accepted, wrong code rejected, drift ±1 step accepted
const secret = "JBSWY3DPEHPK3PXP"; // classic RFC example secret
const now = Math.floor(Date.now() / 1000);
const step = Math.floor(now / 30);
const code = await hotp(base32Decode(secret), step);
if (await verifyTOTP(code, secret, now)) console.log("verifyTOTP current: OK");
else { console.log("verifyTOTP current: FAIL"); fails++; }
if (await verifyTOTP(await hotp(base32Decode(secret), step - 1), secret, now)) console.log("verifyTOTP drift -1 step: OK");
else { console.log("verifyTOTP drift -1: FAIL"); fails++; }
const wrong = code === "000000" ? "111111" : "000000";
if (!(await verifyTOTP(wrong, secret, now))) console.log("verifyTOTP wrong rejected: OK");
else { console.log("verifyTOTP wrong rejected: FAIL"); fails++; }

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
