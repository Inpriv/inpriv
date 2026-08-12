// scripts/verify-derive.mjs — regression guard for client-side key derivation.
// Copyright (c) 2026 Aurex Labs — MIT License
//
// Asserts that the SAME crypto code path used in the browser produces the
// Phantom-standard address for the canonical BIP39 test mnemonic.
//
// Run:  npm run verify   (after npm run build)
//
// Expected Phantom-standard address for
//   "abandon abandon ... about"  at  m/44'/501'/0'/0'
// is:  HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk
// (independently confirmed by @noble/ed25519 + ed25519-hd-key during planning).

import { generateMnemonic, validateMnemonic, deriveSeedFromMnemonic, keypairFromSeed, addressFromPublicKey, PATH_PHANTOM, PATH_LEGACY_ZERO } from "../src/crypto.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const EXPECTED_PHANTOM = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const EXPECTED_LEGACY = "B9sVeu4rJU12oUrUtzjc6BSNuEXdfvurZkdcaTVkP2LY";

let failures = 0;
function assert(name, cond, extra = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${extra}`);
    failures++;
  }
}

console.log("\nZero Wallet — derivation verification\n");

// 1. mnemonic round-trips
assert("mnemonic validates", validateMnemonic(TEST_MNEMONIC));
// "zzz"/"qqq" are not BIP39 words → must be rejected.
assert("mnemonic rejects invalid words", !validateMnemonic("zzz zzz zzz zzz zzz zzz zzz zzz zzz zzz zzz zzz"));
// Valid words but a deliberately wrong checksum must also be rejected.
assert("mnemonic rejects bad checksum", !validateMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"));
const m = generateMnemonic();
assert("generateMnemonic returns 12 words", m.split(" ").length === 12, `→ got ${m.split(" ").length}`);
assert("generated mnemonic is valid", validateMnemonic(m));

// 2. Phantom path → expected address
const seedPh = deriveSeedFromMnemonic(TEST_MNEMONIC, PATH_PHANTOM);
const kpPh = keypairFromSeed(seedPh);
const addrPh = addressFromPublicKey(kpPh.publicKey);
assert("Phantom path matches Phantom address", addrPh === EXPECTED_PHANTOM, `→ got ${addrPh}`);

// 3. Legacy path → expected address
const seedLg = deriveSeedFromMnemonic(TEST_MNEMONIC, PATH_LEGACY_ZERO);
const kpLg = keypairFromSeed(seedLg);
const addrLg = addressFromPublicKey(kpLg.publicKey);
assert("Legacy path matches old .zero address", addrLg === EXPECTED_LEGACY, `→ got ${addrLg}`);

// 4. determinism
const seedPh2 = deriveSeedFromMnemonic(TEST_MNEMONIC, PATH_PHANTOM);
assert("derivation is deterministic", seedPh.every((b, i) => b === seedPh2[i]));

// 5. the two paths must differ (sanity)
assert("Phantom ≠ Legacy address", addrPh !== addrLg);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion(s) broken.\n`);
  process.exit(1);
}
console.log("All derivation checks passed. Seed phrases will derive Phantom-compatible addresses.\n");
