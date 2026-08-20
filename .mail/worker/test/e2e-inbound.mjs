// Real-delivery E2E for Inpriv Mail inbound:
// register a throwaway account (real RSA-OAEP keys), send a REAL email to it
// via Resend, poll until the svix-signed webhook stores it, then decrypt the
// envelope with the account's private key — proving the browser decrypt path.
// Usage: node test/e2e-inbound.mjs <read-key-file>
import fs from "node:fs/promises";

const BASE = "https://mail.inpriv.xyz";
const readKey = (await fs.readFile(process.argv[2], "utf8")).trim();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── client crypto (mirrors public/index.js) ─────────────────────────────────
const PASS_ITERS = 300_000, PBKDF2_CAP = 100_000;
async function deriveAes(password, saltB64) {
  const rounds = Math.ceil(PASS_ITERS / PBKDF2_CAP);
  let material = enc.encode(password), bits;
  for (let r = 0; r < rounds; r++) {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: b64d(saltB64), iterations: Math.min(PASS_ITERS - r * PBKDF2_CAP, PBKDF2_CAP), hash: "SHA-256" },
      key, 256);
    material = new Uint8Array(bits);
  }
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const username = "inbe2e" + Math.random().toString(36).slice(2, 8);
const password = "e2e-test-password-123";

const kp = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["encrypt", "decrypt"]);

const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
const aesKey = await deriveAes(password, salt);
const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
const privIv = crypto.getRandomValues(new Uint8Array(12));
const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: privIv }, aesKey, pkcs8);
const spki = await crypto.subtle.exportKey("spki", kp.publicKey);

console.log("1. registering", username + "@inpriv.xyz");
const reg = await (await fetch(`${BASE}/api/v1/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username, password, password_confirm: password,
    public_key: b64(spki),
    encrypted_private_key: b64(wrapped),
    priv_iv: b64(privIv.buffer),
    priv_salt: salt,
    priv_iter: PASS_ITERS,
  }),
})).json();
if (!reg.token) { console.error("register failed:", JSON.stringify(reg)); process.exit(1); }
console.log("   ok, user id", reg.user.id);

// ── send a REAL email to it via Resend ──────────────────────────────────────
const marker = "INBOUND-E2E-" + Date.now();
const subject = "Real inbound test " + marker;
console.log("2. sending real email via Resend…");
const send = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${readKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    from: "Inpriv Test <test@inpriv.xyz>",
    to: [`${username}@inpriv.xyz`],
    subject,
    text: `Hello from the real delivery chain.\nMarker: ${marker}\nIf you can read this in Inpriv Mail, inbound works end to end.`,
  }),
});
const sendJson = await send.json().catch(() => ({}));
console.log("   resend:", send.status, sendJson.id || JSON.stringify(sendJson));
if (!send.ok) process.exit(1);

// ── poll until the webhook stores it ────────────────────────────────────────
console.log("3. polling inbox for the real webhook…");
let msg = null;
for (let i = 0; i < 40 && !msg; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const msgs = await (await fetch(`${BASE}/api/v1/messages`, {
    headers: { Authorization: `Bearer ${reg.token}` },
  })).json();
  msg = (msgs.items || []).find((m) => m.subject === subject);
  if (!msg) process.stdout.write(".");
}
console.log("");
if (!msg) { console.error("FAIL: message never arrived via real webhook"); process.exit(1); }
console.log("   WEBHOOK DELIVERED ✓  id:", msg.id, "| from:", msg.peer_address, "| label:", msg.peer_label);

// ── decrypt with the private key (browser path) ─────────────────────────────
const full = await (await fetch(`${BASE}/api/v1/messages/${msg.id}`, {
  headers: { Authorization: `Bearer ${reg.token}` },
})).json();

const rawAes = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, kp.privateKey, b64d(full.encrypted_aes_key));
const aes = await crypto.subtle.importKey("raw", rawAes, { name: "AES-GCM" }, false, ["decrypt"]);
const ct = new Uint8Array(b64d(full.ciphertext)), tag = new Uint8Array(b64d(full.auth_tag));
const merged = new Uint8Array(ct.length + tag.length);
merged.set(ct, 0); merged.set(tag, ct.length);
const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(b64d(full.iv)) }, aes, merged);
const body = dec.decode(pt);

console.log("   DECRYPTED ✓  body sample:", JSON.stringify(body.slice(0, 90)));
console.log(body.includes(marker) ? "   MARKER FOUND ✓ — full chain green" : "   MARKER MISSING ✗");
console.log(body.includes(marker) ? "E2E PASS" : "E2E FAIL");
