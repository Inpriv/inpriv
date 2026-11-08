// Shared account cryptography. Keep the historical ID password chain unchanged.
const enc = new TextEncoder();
export const PASS_ITERS = 300_000;
export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PBKDF2_CAP = 100_000;

export async function passHash(password, saltB64, iters = PASS_ITERS) {
  const rounds = Math.max(1, Math.floor(iters / PBKDF2_CAP));
  let material = enc.encode(password);
  let bits;
  for (let r = 0; r < rounds; r++) {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: Math.min(iters - r * PBKDF2_CAP, PBKDF2_CAP) },
      key,
      256
    );
    material = new Uint8Array(bits);
  }
  return b64(bits);
}

export function constantTimeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export async function hotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new Uint8Array(buf));
  const b = new Uint8Array(mac);
  const off = b[19] & 0xf;
  const code = ((b[off] & 0x7f) << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export async function verifyTOTP(code, secretBytes, atMs) {
  const step = Math.floor(atMs / 30_000);
  for (const w of [0, -1, 1]) {
    if (constantTimeEq(await hotp(secretBytes, step + w), code)) return step + w;
  }
  return false;
}
