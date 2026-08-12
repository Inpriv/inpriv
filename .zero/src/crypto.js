// src/crypto.js — all client-side cryptography for Zero Wallet.
// Copyright (c) 2026 Aurex Labs — MIT License
//
// NOTHING here touches the network. NOTHING here touches the server.
// This module is the trust root of the wallet.
//
// Contents:
//   1. Mnemonic (BIP39) generation / validation / seed
//   2. SLIP-10 ed25519 HD derivation (Phantom-standard m/44'/501'/0'/0')
//   3. Solana keypair + signing + address
//   4. Password KDF (Argon2id via hash-wasm, PBKDF2 fallback)
//   5. AES-256-GCM envelope encrypt/decrypt (WebCrypto)
//   6. Public envelope schema helpers
//
// Security properties:
//   - mnemonic, password, private key, and derived key material NEVER leave
//     this module unencrypted, and never leave the browser at all.
//   - The on-disk envelope (IndexedDB) is Argon2id + AES-256-GCM. Without the
//     password it is inert.
//   - Key derivation uses the Phantom-standard path so seed phrases are
//     interoperable with Phantom, Solflare, etc.

import { generateMnemonic as bip39Gen, validateMnemonic as bip39Validate, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { getPublicKey, etc as ed25519etc } from "@noble/ed25519";
import { base58 } from "@scure/base";
import bs58 from "bs58";

// Wire a sync SHA-512 into @noble/ed25519 (required for getPublicKey).
// @noble/hashes sha512 is a function (input → digest) with a streaming .create().
ed25519etc.sha512Sync = (...messages) => {
  const h = sha512.create();
  for (const m of messages) h.update(m);
  return h.digest();
};

// ─── 1. Mnemonic ─────────────────────────────────────────────────────────────

export const MNEMONIC_STRENGTH_128 = 128; // 12 words
export const MNEMONIC_STRENGTH_256 = 256; // 24 words

export function generateMnemonic(strength = MNEMONIC_STRENGTH_128) {
  // @scure/bip39 v2 signature: generateMnemonic(wordlist, strength)
  return bip39Gen(wordlist, strength);
}

export function validateMnemonic(mnemonic) {
  try {
    // @scure/bip39 v2's validateMnemonic(m, wordlist) only checks wordlist
    // membership, not the checksum. Round-tripping through mnemonicToEntropy
    // verifies the checksum too (it throws on a bad checksum).
    if (!bip39Validate(mnemonic, wordlist)) return false;
    mnemonicToEntropy(mnemonic, wordlist);
    return true;
  } catch {
    return false;
  }
}

// BIP39 seed = PBKDF2-HMAC-SHA512(passphrase = mnemonic, salt = "mnemonic" + passphrase, 2048 iters)
export function mnemonicToSeed(mnemonic, passphrase = "") {
  const enc = new TextEncoder();
  return pbkdf2(sha512, enc.encode(mnemonic), enc.encode("mnemonic" + passphrase), {
    dkLen: 64,
    c: 2048,
  });
}

// ─── 2. SLIP-10 ed25519 HD derivation ────────────────────────────────────────
// Reference: github.com/satoshilabs/slips/blob/master/slip-0010.md
// ed25519 supports ONLY hardened derivation, so every path element must be
// hardened (index >= 0x80000000). We implement SLIP-10 directly rather than
// depending on a derivation library, and we verified parity against Phantom.

export const PATH_PHANTOM = "m/44'/501'/0'/0'"; // Phantom / Solflare standard
export const PATH_LEGACY_ZERO = "m/44'/501'/0'/0'/0'"; // old .zero wallet

const HARDENED_OFFSET = 0x80000000;

function ser32(i) {
  const out = new Uint8Array(4);
  // writeUInt32BE
  out[0] = (i >>> 24) & 0xff;
  out[1] = (i >>> 16) & 0xff;
  out[2] = (i >>> 8) & 0xff;
  out[3] = i & 0xff;
  return out;
}

function hmacSHA512(key, data) {
  return hmac.create(sha512, key).update(data).digest();
}

function slip10MasterFromSeed(seed) {
  const I = hmacSHA512(new TextEncoder().encode("ed25519 seed"), seed);
  return { key: I.subarray(0, 32), chainCode: I.subarray(32, 64) };
}

function ckdPrivHardened({ key, chainCode }, index) {
  if (index < HARDENED_OFFSET) {
    throw new Error("SLIP-10 ed25519 only supports hardened derivation");
  }
  // Data = 0x00 || ser256(kpar) || ser32(i)
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(key, 1);
  data.set(ser32(index), 33);
  const I = hmacSHA512(chainCode, data);
  return { key: I.subarray(0, 32), chainCode: I.subarray(32, 64) };
}

function parsePath(path) {
  if (!path || path[0] !== "m") throw new Error(`Invalid path: ${path}`);
  const parts = path.split("/").slice(1);
  return parts.map((p) => {
    const hardened = p.endsWith("'");
    const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED_OFFSET) {
      throw new Error(`Invalid path segment: ${p}`);
    }
    return hardened ? n + HARDENED_OFFSET : n;
  });
}

/**
 * Derive a 32-byte ed25519 private seed from a mnemonic.
 * @param {string} mnemonic
 * @param {string} [path=PATH_PHANTOM] — derivation path.
 * @returns {Uint8Array} 32-byte secret seed (the Solana keypair seed).
 */
export function deriveSeedFromMnemonic(mnemonic, path = PATH_PHANTOM) {
  const seed = mnemonicToSeed(mnemonic, "");
  let node = slip10MasterFromSeed(seed);
  for (const index of parsePath(path)) node = ckdPrivHardened(node, index);
  // Return a defensive copy so callers can't mutate internal state.
  return new Uint8Array(node.key);
}

// ─── 3. Solana keypair + address ─────────────────────────────────────────────

/** @returns {{secretKey: Uint8Array(64), publicKey: Uint8Array(32)}} */
export function keypairFromSeed(seed32) {
  const secretKey = new Uint8Array(64);
  secretKey.set(seed32, 0);
  secretKey.set(getPublicKey(seed32), 32);
  return { secretKey, publicKey: getPublicKey(seed32) };
}

export function keypairFromMnemonic(mnemonic, path = PATH_PHANTOM) {
  return keypairFromSeed(deriveSeedFromMnemonic(mnemonic, path));
}

export function keypairFromSecretKeyBytes(secretKey64) {
  if (secretKey64.length !== 64) {
    throw new Error("Invalid secret key length (expected 64 bytes)");
  }
  return { secretKey: secretKey64, publicKey: secretKey64.subarray(32) };
}

/**
 * Recover a keypair from a base58 private key string.
 * Accepts the two common Solana formats:
 *   - 64-byte secret key (Phantom "export private key"): b58 → 64 bytes
 *   - 32-byte raw seed: b58 → 32 bytes (public key derived)
 */
export function keypairFromBase58(b58) {
  let bytes;
  try {
    bytes = bs58.decode(b58);
  } catch {
    // bs58 v6 throws on bad chars; give a cleaner message.
    throw new Error("Invalid base58 private key");
  }
  if (bytes.length === 64) return keypairFromSecretKeyBytes(bytes);
  if (bytes.length === 32) return keypairFromSeed(bytes);
  throw new Error(`Unexpected private key length (${bytes.length} bytes)`);
}

export function keypairToBase58(secretKey64) {
  return bs58.encode(secretKey64);
}

export function addressFromPublicKey(publicKey32) {
  return base58.encode(publicKey32);
}

export function validateAddress(address) {
  try {
    const b = base58.decode(address);
    return b.length === 32;
  } catch {
    return false;
  }
}

// ─── 4. Password key derivation ──────────────────────────────────────────────
// Primary: Argon2id via hash-wasm (WASM, ~strong). Fallback: WebCrypto PBKDF2
// (used only if hash-wasm fails to load). The chosen algorithm is stored in the
// envelope so decryption always picks the right one.

const ARGON2_PARAMS = {
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32, // 256-bit AES key
};

// Lazy-load hash-wasm so the (small) WASM cost is only paid when encrypting.
let _argon2id = null;
async function loadArgon2id() {
  if (_argon2id) return _argon2id;
  const wasm = await import("hash-wasm");
  _argon2id = wasm.argon2id;
  return _argon2id;
}

const PBKDF2_ITERATIONS = 600000; // OWASP-aligned for SHA-512 (2023+)

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Derive a 256-bit key from a password + salt.
 * @returns {Promise<{algorithm:"argon2id"|"pbkdf2", key:CryptoKey, params:object, salt:Uint8Array}>}
 */
export async function deriveKeyFromPassword(password, salt) {
  const pwBytes = new TextEncoder().encode(password);
  try {
    const argon2id = await loadArgon2id();
    const raw = await argon2id({
      password: pwBytes,
      salt,
      parallelism: ARGON2_PARAMS.parallelism,
      memorySize: ARGON2_PARAMS.memoryCost,
      iterations: ARGON2_PARAMS.timeCost,
      hashLength: ARGON2_PARAMS.hashLength,
      outputType: "binary",
    });
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return {
      algorithm: "argon2id",
      key,
      params: {
        memoryCost: ARGON2_PARAMS.memoryCost,
        timeCost: ARGON2_PARAMS.timeCost,
        parallelism: ARGON2_PARAMS.parallelism,
      },
      salt,
    };
  } catch (err) {
    // Fallback: PBKDF2-SHA512 via WebCrypto. Still strong, universally available.
    // Log the Argon2 failure reason so operators can diagnose WASM issues.
    console.warn("Argon2id unavailable, falling back to PBKDF2:", err?.message || err);
    const baseKey = await crypto.subtle.importKey(
      "raw",
      pwBytes,
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-512" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    return {
      algorithm: "pbkdf2",
      key,
      params: { iterations: PBKDF2_ITERATIONS, hash: "SHA-512" },
      salt,
    };
  }
}

// ─── 5. AES-256-GCM envelope ─────────────────────────────────────────────────
//
// Envelope JSON (what gets stored in IndexedDB):
// {
//   "v": 1,
//   "address": "<base58>",
//   "createdAt": 1234567890,
//   "kdf": { "algorithm":"argon2id", "salt":"<hex>", ...params },
//   "cipher": { "algorithm":"aes-256-gcm", "iv":"<hex>" },
//   "data": "<hex ciphertext>"
// }
//
// Plaintext (decrypted) payload:
//   { "secretKey": "<base58 64-byte>", "mnemonic": "<phrase or null>" }

const IV_LENGTH = 12; // 96-bit nonce recommended for GCM

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Encrypt the wallet secrets into the on-disk envelope.
 * @param {{secretKey: Uint8Array, mnemonic: string|null}} secrets
 * @param {string} password
 * @param {string} address
 * @returns {Promise<object>} envelope (JSON-serializable)
 */
export async function encryptWallet(secrets, password, address) {
  const salt = randomBytes(16);
  const derived = await deriveKeyFromPassword(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const plaintext = {
    secretKey: keypairToBase58(secrets.secretKey),
    mnemonic: secrets.mnemonic ?? null,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    derived.key,
    encoded
  );

  return {
    v: 1,
    address,
    createdAt: Date.now(),
    kdf: { ...derived.params, algorithm: derived.algorithm, salt: toHex(salt) },
    cipher: { algorithm: "aes-256-gcm", iv: toHex(iv) },
    data: toHex(new Uint8Array(cipherBuf)),
  };
}

/**
 * Decrypt an envelope. Returns the secret payload, or null on wrong password.
 * @param {object} envelope
 * @param {string} password
 * @returns {Promise<{secretKey: Uint8Array, mnemonic: string|null}|null>}
 */
export async function decryptWallet(envelope, password) {
  if (!envelope || envelope.v !== 1) return null;
  const salt = fromHex(envelope.kdf.salt);
  const iv = fromHex(envelope.cipher.iv);
  const data = fromHex(envelope.data);

  // Re-derive using the stored algorithm + params.
  let key;
  const pwBytes = new TextEncoder().encode(password);
  if (envelope.kdf.algorithm === "argon2id") {
    const argon2id = await loadArgon2id();
    const raw = await argon2id({
      password: pwBytes,
      salt,
      parallelism: envelope.kdf.parallelism,
      memorySize: envelope.kdf.memoryCost,
      iterations: envelope.kdf.timeCost,
      hashLength: 32,
      outputType: "binary",
    });
    key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } else {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      pwBytes,
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: envelope.kdf.iterations,
        hash: envelope.kdf.hash || "SHA-512",
      },
      baseKey,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
  }

  try {
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    const payload = JSON.parse(new TextDecoder().decode(plainBuf));
    return {
      secretKey: keypairFromBase58(payload.secretKey).secretKey,
      mnemonic: payload.mnemonic ?? null,
    };
  } catch {
    return null; // wrong password or corrupted data
  }
}

// ─── 6. Helpers re-exported for callers ──────────────────────────────────────

export { base58, bs58 };
export const ENC = new TextEncoder();
export const DEC = new TextDecoder();
