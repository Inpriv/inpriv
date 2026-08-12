// src/sign.js — Solana transaction building & signing, fully in-browser.
// Copyright (c) 2026 Aurex Labs — MIT License
//
// The server never sees the private key; it only relays the final signed bytes.

import {
  Transaction,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import { LAMPORTS_PER_SOL, getLatestBlockhash, sendTransaction } from "./rpc.js";

/**
 * Build, sign, and broadcast a SOL transfer.
 * @param {{secretKey: Uint8Array, publicKey: Uint8Array}} keypair
 * @param {string} destinationAddress
 * @param {number} amountSol
 * @returns {Promise<string>} transaction signature
 */
export async function sendSol(keypair, destinationAddress, amountSol) {
  const fromPubkey = new PublicKey(keypair.publicKey);
  const toPubkey = new PublicKey(destinationAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error("Invalid amount");
  }

  const { blockhash } = await getLatestBlockhash();

  const ix = SystemProgram.transfer({
    fromPubkey,
    toPubkey,
    lamports,
  });

  const tx = new Transaction({ feePayer: fromPubkey, blockhash }).add(ix);
  tx.sign({ publicKey: fromPubkey, secretKey: keypair.secretKey });

  const serialized = tx.serialize().toString("base64");
  // The proxy accepts base64 too; sendTransaction here expects base58 by default,
  // so we pass a per-call encoding override via a direct rpc() through the proxy.
  return sendRawBase64(serialized);
}

import { rpc } from "./rpc.js";

async function sendRawBase64(b64) {
  return rpc("sendTransaction", [
    b64,
    { encoding: "base64", preflightCommitment: "confirmed", skipPreflight: false },
  ]);
}
