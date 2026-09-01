// src/wallet-store.js — encrypted-wallet persistence in IndexedDB.
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// Stores only ENCRYPTED envelopes (produced by crypto.encryptWallet). The
// plaintext private key / mnemonic are NEVER persisted — they live only in
// the in-memory session (see app.js) for the duration the wallet is unlocked.
//
// Two object stores:
//   - "wallets"  : keyPath "address" → envelope JSON
//   - "kv"       : misc key/value (e.g. last-used address hint, auto-lock pref)

const DB_NAME = "zero-wallet";
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("wallets")) {
        db.createObjectStore("wallets", { keyPath: "address" });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ─── Wallet envelopes ────────────────────────────────────────────────────────

export async function putWallet(envelope) {
  const db = await openDB();
  await reqAsPromise(tx(db, "wallets", "readwrite").put(envelope));
}

export async function getWallet(address) {
  const db = await openDB();
  return reqAsPromise(tx(db, "wallets", "readonly").get(address));
}

export async function listWallets() {
  const db = await openDB();
  return reqAsPromise(tx(db, "wallets", "readonly").getAll());
}

export async function deleteWallet(address) {
  const db = await openDB();
  await reqAsPromise(tx(db, "wallets", "readwrite").delete(address));
}

// ─── Key/value (prefs) ───────────────────────────────────────────────────────

export async function kvGet(key, fallback = null) {
  const db = await openDB();
  const row = await reqAsPromise(tx(db, "kv", "readonly").get(key));
  return row ? row.value : fallback;
}

export async function kvSet(key, value) {
  const db = await openDB();
  await reqAsPromise(tx(db, "kv", "readwrite").put({ key, value }));
}

export async function kvDelete(key) {
  const db = await openDB();
  await reqAsPromise(tx(db, "kv", "readwrite").delete(key));
}
