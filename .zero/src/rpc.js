// src/rpc.js — talks ONLY to our own server proxy (/api/rpc, /api/sol-price).
// Copyright (c) 2026 Aurex Labs — MIT License
//
// The server forwards to the real Solana RPC + price feeds. This keeps the
// client free of CORS concerns and lets operators swap RPC providers without a
// client rebuild. The server is a dumb relay — it never sees keys or signatures.

const RPC_URL = "/api/rpc";
const PRICE_URL = "/api/sol-price";
const CONFIG_URL = "/api/config";

let _id = 1;

/**
 * Generic Solana JSON-RPC call via the server proxy.
 * @param {string} method
 * @param {any[]} [params]
 * @returns {Promise<any>} the RPC "result" field.
 * @throws {Error} with a readable message on RPC error or network failure.
 */
export async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: _id++, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Network error (${res.status})`);
  }
  const json = await res.json();
  if (json.error) {
    const msg =
      typeof json.error === "string"
        ? json.error
        : json.error.message || "Solana RPC error";
    throw new Error(msg);
  }
  return json.result;
}

// ─── Typed helpers used by the UI ────────────────────────────────────────────

/** Lamports per SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

export async function getBalance(address) {
  const r = await rpc("getBalance", [address, { commitment: "confirmed" }]);
  return (r.value || 0) / LAMPORTS_PER_SOL;
}

export async function getLatestBlockhash() {
  const r = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  return r.value; // { blockhash, lastValidBlockHeight }
}

export async function getSignaturesForAddress(address, limit = 20) {
  const r = await rpc("getSignaturesForAddress", [
    address,
    { limit, commitment: "confirmed" },
  ]);
  return r || [];
}

export async function getTransaction(signature) {
  const r = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  return r;
}

/** Submit a base58-encoded, already-signed transaction. Returns the signature. */
export async function sendTransaction(serializedBase58) {
  const r = await rpc("sendTransaction", [
    serializedBase58,
    { encoding: "base58", preflightCommitment: "confirmed", skipPreflight: false },
  ]);
  return r; // signature string
}

// ─── Price + config (also via proxy) ─────────────────────────────────────────

let _priceCache = { price: 0, time: 0 };
export async function getSolPrice() {
  const now = Date.now();
  if (_priceCache.price && now - _priceCache.time < 60_000) return _priceCache.price;
  try {
    const r = await fetch(PRICE_URL);
    const j = await r.json();
    if (j && j.price) {
      _priceCache = { price: j.price, time: now };
      return j.price;
    }
  } catch {
    /* ignore — UI handles zero price gracefully */
  }
  return _priceCache.price || 0;
}

let _configCache = null;
export async function getConfig() {
  if (_configCache) return _configCache;
  try {
    const r = await fetch(CONFIG_URL);
    _configCache = await r.json();
  } catch {
    _configCache = { network: "mainnet-beta", rpcLabel: "mainnet" };
  }
  return _configCache;
}
