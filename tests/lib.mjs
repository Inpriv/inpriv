// Shared helpers for the local security tests (see tests/README.md).
// Only built-in Node modules: node:test, node:sqlite, WebCrypto.
import { createHmac, webcrypto as crypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE = join(ROOT, ".wrangler/t");
export const URLS = {
  landing: "http://127.0.0.1:8795",
  temp: "http://127.0.0.1:8796",
  admin: "http://127.0.0.1:8797",
  id: "http://127.0.0.1:8798",
  mail: "http://127.0.0.1:8799",
};
export const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const WHSEC = "whsec_dGVzdC1vbmx5LXdlYmhvb2stc2VjcmV0LTEyMzQ=";

const enc = new TextEncoder();
const dec = new TextDecoder();
export const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64");
export const b64d = (s) => new Uint8Array(Buffer.from(s, "base64"));
export const rand = (n = 6) => Math.random().toString(36).slice(2, 2 + n);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP client with a cookie jar and an Origin, like a browser page ────────
const SETUP = new Set(["/api/register", "/api/login", "/api/v1/login", "/api/2fa/setup", "/api/2fa/confirm"]);
let ipCounter = 0;
const RUN = Math.floor(Math.random() * 250) + 1;
export class Client {
  constructor(base, { origin = base, ip } = {}) {
    this.base = base;
    this.origin = origin;
    this.cookies = new Map();
    // a fresh made-up address per client, so per-network limits don't carry
    // over between clients or runs
    this.ip = ip || `10.${RUN}.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;
    this.lastSetCookie = [];
  }
  // Local only: every Worker runs its own workerd process on the same SQLite
  // files, so a write can hit SQLITE_BUSY ("internal error", HTTP 500) — in
  // production D1 has one writer per database. Reads and account setup are
  // retried; the requests a test checks exact results of are not.
  async req(path, opts = {}) {
    const retry = (opts.method || "GET") === "GET" || SETUP.has(path);
    for (let i = 0; ; i++) {
      const r = await this.once(path, opts);
      if (!retry || i >= 3 || (r.status ?? 0) !== 500) return r;
      console.error(`  (local SQLITE_BUSY? retrying ${path})`);
      await sleep(150 * (i + 1));
    }
  }
  async once(path, { method = "GET", body, headers = {}, origin = this.origin, raw = false } = {}) {
    const h = { "CF-Connecting-IP": this.ip, "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0", ...headers };
    if (origin && method !== "GET") h.Origin = origin;
    if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(this.base + path, {
      method, headers: h, redirect: "manual",
      body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
    });
    this.lastSetCookie = res.headers.getSetCookie();
    for (const c of this.lastSetCookie) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/max-age=0/i.test(c) || !v) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data, headers: res.headers };
  }
  get(p, o = {}) { return this.req(p, { ...o, method: "GET" }); }
  post(p, body = {}, o = {}) { return this.req(p, { ...o, method: "POST", body }); }
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────
export function totp(secret = TOTP_SECRET, t = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0; const out = [];
  for (const c of secret) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 255); } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac("sha1", Buffer.from(out)).update(buf).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
export const wrongCode = (c) => String((Number(c) + 500000) % 1e6).padStart(6, "0");

// ── local D1 databases (SQLite files kept by wrangler dev) ──────────────────
// Every Worker runs in its own workerd process on the same files, so the test
// opens a file only for one statement at a time (with a busy timeout) to
// leave the locks to the Workers.
const _files = {};
function fileOf(name) {
  if (_files[name]) return _files[name];
  const dir = join(STATE, "v3/d1/miniflare-D1DatabaseObject");
  const marker = { id: "totp_secrets", mail: "device_keys", temp: "mailboxes" }[name];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite")) {
    const d = new DatabaseSync(join(dir, f));
    const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(marker);
    d.close();
    if (t) return (_files[name] = join(dir, f));
  }
  throw new Error("local database not found: " + name);
}
export function db(name) {
  const file = fileOf(name);
  const once = (sql, fn) => {
    const d = new DatabaseSync(file);
    try { d.exec("PRAGMA busy_timeout = 10000"); return fn(d.prepare(sql)); } finally { d.close(); }
  };
  return {
    prepare: (sql) => ({
      run: (...a) => once(sql, (st) => st.run(...a)),
      get: (...a) => once(sql, (st) => st.get(...a)),
      all: (...a) => once(sql, (st) => st.all(...a)),
    }),
  };
}

// ── the browser's mailbox crypto, mirrored for API tests ────────────────────
const RSA = { name: "RSA-OAEP", hash: "SHA-256" };
const RING_AAD = enc.encode("inpriv-mail-keyring-v2");
export const KEY_ITERS = 600000;

export async function keyIdOf(spki) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
  return Buffer.from(d.slice(0, 16)).toString("hex");
}
export async function newKey() {
  const kp = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  return { id: await keyIdOf(spki), spki: b64(spki), pkcs8: b64(pkcs8), priv: kp.privateKey, pub: kp.publicKey };
}
export async function deriveKek(passphrase, saltB64, iters = KEY_ITERS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: iters }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
export async function sealRing(keys, current, passphrase, iters = KEY_ITERS) {
  const ring = { v: 2, current, keys: keys.map((k) => ({ id: k.id, created: Date.now(), pkcs8: k.pkcs8 })) };
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const kek = await deriveKek(passphrase, salt, iters);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: RING_AAD }, kek, enc.encode(JSON.stringify(ring)));
  return { key_format: 2, encrypted_private_key: b64(ct), priv_iv: b64(iv), priv_salt: salt, priv_iter: iters };
}
export async function openRing(user, passphrase) {
  const kek = await deriveKek(passphrase, user.priv_salt, user.priv_iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(user.priv_iv), additionalData: RING_AAD }, kek, b64d(user.encrypted_private_key));
  return JSON.parse(dec.decode(pt));
}
export async function importPriv(pkcs8B64) {
  return crypto.subtle.importKey("pkcs8", b64d(pkcs8B64), RSA, false, ["decrypt"]);
}
export async function importPub(spkiB64) {
  return crypto.subtle.importKey("spki", b64d(spkiB64), RSA, false, ["encrypt"]);
}
export async function answer(challengeB64, priv) {
  return b64(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, priv, b64d(challengeB64)));
}
// hybrid envelope, same format as the page (tag split off)
export async function seal(pub, text) {
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(text)));
  const raw = await crypto.subtle.exportKey("raw", k);
  return {
    encrypted_aes_key: b64(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw)),
    iv: b64(iv), ciphertext: b64(ct.slice(0, -16)), auth_tag: b64(ct.slice(-16)),
  };
}
export async function unseal(priv, e) {
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, priv, b64d(e.encrypted_aes_key));
  const k = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const merged = new Uint8Array([...b64d(e.ciphertext), ...b64d(e.auth_tag)]);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(e.iv) }, k, merged));
}

// format-1 envelope (the old flow): the private key under chained PBKDF2 of
// the password, plus the same hash as Inpriv ID's
export async function legacyHash(password, saltB64, iters = 300000) {
  const CAP = 100000, rounds = Math.ceil(iters / CAP);
  let material = enc.encode(password), bits;
  for (let r = 0; r < rounds; r++) {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: Math.min(iters - r * CAP, CAP) }, key, 256);
    material = new Uint8Array(bits);
  }
  return bits;
}
export async function legacyEnvelope(password, pkcs8B64) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const aes = await crypto.subtle.importKey("raw", await legacyHash(password, salt), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, b64d(pkcs8B64));
  return { encrypted_private_key: b64(ct), priv_iv: b64(iv), priv_salt: salt, priv_iter: 300000 };
}

// ── accounts ─────────────────────────────────────────────────────────────────
export async function registerId(username, password) {
  const c = new Client(URLS.id);
  const r = await c.post("/api/register", { username, password });
  if (r.status !== 200) throw new Error(`register ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

// An Inpriv ID with a format-2 mailbox. Returns the Mail client, keys, etc.
export async function newMailbox(username, password, passphrase) {
  await registerId(username, password);
  const mail = new Client(URLS.mail);
  const r = await mail.post("/api/v1/login", { username, password });
  if (r.body.status !== "needs_init") throw new Error("expected needs_init: " + JSON.stringify(r.body));
  const key = await newKey();
  const envelope = await sealRing([key], key.id, passphrase);
  const r2 = await mail.post("/api/v1/init-keys", { init_ticket: r.body.init_ticket, public_key: key.spki, key_id: key.id, envelope });
  if (r2.status !== 200) throw new Error("init-keys: " + JSON.stringify(r2.body));
  return { mail, key, user: r2.body.user, username, password, passphrase };
}

export async function enable2fa(idClient) {
  const s = await idClient.post("/api/2fa/setup", {});
  if (s.status !== 200) throw new Error("2fa setup " + JSON.stringify(s.body));
  // the test secret is fixed in the DB so codes are predictable
  const secret = s.body.secret;
  const c = await idClient.post("/api/2fa/confirm", { code: totp(secret) });
  if (c.status !== 200) throw new Error("2fa confirm " + JSON.stringify(c.body));
  return { secret, recovery: c.body.recovery_codes };
}

// ── signed Resend/svix webhook ──────────────────────────────────────────────
export function svixHeaders(body, { id = "msg_" + rand(12), ts = Math.floor(Date.now() / 1000), secret = WHSEC } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}`, "Content-Type": "application/json" };
}

export async function scheduled(base) {
  const r = await fetch(base + "/__scheduled?cron=" + encodeURIComponent("0 * * * *"));
  return r.status;
}
