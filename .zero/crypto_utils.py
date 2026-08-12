"""
crypto_utils.py — Cryptographic and Solana blockchain operations for Zero Wallet.
Copyright (c) 2026 Aurex Labs — MIT License

Provides key generation (Ed25519 via BIP39), wallet encryption (AES-256-GCM + Argon2id),
and Solana RPC interactions (balance, send, transaction history).
"""

import os
import json
import time
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
import httpx
from base58 import b58decode, b58encode

# Solana
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import transfer, TransferParams
from solders.message import Message
from solders.transaction import Transaction
from solana.rpc.api import Client as SolanaClient
from solana.rpc.commitment import Confirmed

# BIP39 Mnemonic
from mnemonic import Mnemonic

# BIP39 → seed → key derivation
from bip_utils import Bip39SeedGenerator, Bip44, Bip44Coins, Bip44Changes

# Encryption
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Argon2 key derivation — low-level API
from argon2.low_level import hash_secret_raw, Type

# ─── Constants ────────────────────────────────────────────────────────────

SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'"
DEFAULT_RPC_DEVNET = "https://api.devnet.solana.com"
DEFAULT_RPC_MAINNET = "https://api.mainnet-beta.solana.com"
LAMPORTS_PER_SOL = 1_000_000_000

# ─── Wallet Generation / Import ────────────────────────────────────────────


def generate_mnemonic(strength: int = 128) -> str:
    """Generate a BIP39 mnemonic phrase (default 12 words)."""
    mnemo = Mnemonic("english")
    return mnemo.generate(strength=strength)


def mnemonic_to_keypair(mnemonic_str: str) -> Keypair:
    """Derive a Solana Ed25519 keypair from a BIP39 mnemonic."""
    # Generate seed from mnemonic (no passphrase)
    seed = Bip39SeedGenerator(mnemonic_str).Generate()
    # Derive via BIP44 for Solana (coin 501)
    bip44_mst = Bip44.FromSeed(seed, Bip44Coins.SOLANA)
    bip44_acc = bip44_mst.Purpose().Coin().Account(0).Change(Bip44Changes.CHAIN_EXT).AddressIndex(0)
    private_key_bytes = bip44_acc.PrivateKey().Raw().ToBytes()
    # Keypair.from_seed takes the 32-byte private key seed
    return Keypair.from_seed(private_key_bytes)


def private_key_to_keypair(private_key_b58: str) -> Keypair:
    """Recover keypair from a base58-encoded private key string.
    
    Supports both 32-byte (seed) and 64-byte (full keypair) formats.
    """
    decoded = b58decode(private_key_b58)
    if len(decoded) == 32:
        return Keypair.from_seed(decoded)
    return Keypair.from_bytes(decoded)


def keypair_to_address(keypair: Keypair) -> str:
    """Get the base58 public key (address) for a keypair."""
    return str(keypair.pubkey())


def keypair_to_private_key_b58(keypair: Keypair) -> str:
    """Export private key as base58 string."""
    return b58encode(bytes(keypair)).decode()


# ─── Encrypt / Decrypt Private Key ──────────────────────────────────

# Constants for Argon2id
ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST = 64 * 1024  # 64 MB
ARGON2_PARALLELISM = 4
ARGON2_KEY_LENGTH = 32  # 256 bits for AES-256
AES_NONCE_LENGTH = 12  # 96 bits


def _derive_key(password: str, salt: bytes) -> bytes:
    """Derive a 256-bit AES key from a password using Argon2id."""
    return hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_COST,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_KEY_LENGTH,
        type=Type.ID,
    )


def encrypt_private_key(private_key_bytes: bytes, password: str) -> dict:
    """
    Encrypt a private key with a password.

    Returns a JSON-serializable dict:
        { "ciphertext": (hex), "nonce": (hex), "salt": (hex) }
    """
    salt = os.urandom(16)
    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)
    nonce = os.urandom(AES_NONCE_LENGTH)
    ciphertext = aesgcm.encrypt(nonce, private_key_bytes, None)
    return {
        "ciphertext": ciphertext.hex(),
        "nonce": nonce.hex(),
        "salt": salt.hex(),
    }


def decrypt_private_key(encrypted: dict, password: str) -> Optional[bytes]:
    """
    Decrypt a private key using the password.

    Returns the raw private key bytes, or None if the password is wrong.
    """
    try:
        salt = bytes.fromhex(encrypted["salt"])
        nonce = bytes.fromhex(encrypted["nonce"])
        ciphertext = bytes.fromhex(encrypted["ciphertext"])
        key = _derive_key(password, salt)
        aesgcm = AESGCM(key)
        return aesgcm.decrypt(nonce, ciphertext, None)
    except Exception:
        return None


# ─── Remember-Me: encrypt/decrypt with a raw key (no Argon2) ─────────────


def encrypt_with_raw_key(data: bytes, key: bytes) -> dict:
    """Encrypt data with a raw 256-bit key. Returns {ciphertext, nonce} hex dict."""
    aesgcm = AESGCM(key)
    nonce = os.urandom(AES_NONCE_LENGTH)
    ciphertext = aesgcm.encrypt(nonce, data, None)
    return {"ciphertext": ciphertext.hex(), "nonce": nonce.hex()}


def decrypt_with_raw_key(encrypted: dict, key: bytes) -> Optional[bytes]:
    """Decrypt data with a raw 256-bit key. Returns bytes or None."""
    try:
        nonce = bytes.fromhex(encrypted["nonce"])
        ciphertext = bytes.fromhex(encrypted["ciphertext"])
        aesgcm = AESGCM(key)
        return aesgcm.decrypt(nonce, ciphertext, None)
    except Exception:
        return None


# ─── Wallet Storage (Multi-Wallet) ───────────────────────────────────────
#
# Each wallet is stored as an individual encrypted JSON file keyed by
# its Solana address, enabling any number of independent wallets to
# coexist on the same server.
#
#   ~/.crypto-wallet/
#     wallets/
#       <address>.json          ← encrypted wallet data
#     sessions/
#       <address>.auto_unlock   ← per-wallet Remember-Me token


def get_wallet_dir() -> str:
    """Get the base wallet storage directory (~/.crypto-wallet)."""
    home = os.path.expanduser("~")
    wallet_dir = os.path.join(home, ".crypto-wallet")
    os.makedirs(wallet_dir, exist_ok=True)
    return wallet_dir


def get_wallets_dir() -> str:
    """Get the per-wallet storage directory (~/.crypto-wallet/wallets)."""
    wallets_dir = os.path.join(get_wallet_dir(), "wallets")
    os.makedirs(wallets_dir, exist_ok=True)
    return wallets_dir


def get_sessions_dir() -> str:
    """Get the Remember-Me sessions directory (~/.crypto-wallet/sessions)."""
    sessions_dir = os.path.join(get_wallet_dir(), "sessions")
    os.makedirs(sessions_dir, exist_ok=True)
    return sessions_dir


def _wallet_path(address: str) -> str:
    """Return the filesystem path for a wallet file."""
    return os.path.join(get_wallets_dir(), f"{address}.json")


def _session_path(address: str) -> str:
    """Return the filesystem path for a Remember-Me session file."""
    return os.path.join(get_sessions_dir(), f"{address}.auto_unlock")


def list_wallets() -> list:
    """Return a sorted list of wallet addresses currently on disk."""
    wallets_dir = get_wallets_dir()
    addresses = []
    try:
        for entry in os.scandir(wallets_dir):
            if entry.is_file() and entry.name.endswith(".json"):
                addresses.append(entry.name[:-5])  # strip ".json"
    except FileNotFoundError:
        pass
    addresses.sort()
    return addresses


def save_wallet(data: dict) -> None:
    """Save encrypted wallet data to wallets/<address>.json."""
    address = data.get("address")
    if not address:
        raise ValueError("Wallet data must include an 'address' field")
    path = _wallet_path(address)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def load_wallet(address: str) -> Optional[dict]:
    """Load encrypted wallet data for a specific address, or None."""
    path = _wallet_path(address)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def delete_wallet(address: str) -> None:
    """Delete the wallet file for a specific address."""
    path = _wallet_path(address)
    if os.path.exists(path):
        os.remove(path)
    # Also clean up any Remember-Me session for this wallet
    session_path = _session_path(address)
    if os.path.exists(session_path):
        os.remove(session_path)


# ─── Remember-Me Session Helpers ────────────────────────────────────────


def save_auto_unlock(address: str, data: dict) -> None:
    """Persist a Remember-Me token for a wallet address."""
    path = _session_path(address)
    with open(path, "w") as f:
        json.dump(data, f)


def load_auto_unlock(address: str) -> Optional[dict]:
    """Load a Remember-Me token for a wallet address, or None."""
    path = _session_path(address)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def delete_auto_unlock(address: str) -> None:
    """Delete the Remember-Me token for a wallet address."""
    path = _session_path(address)
    if os.path.exists(path):
        os.remove(path)


def list_auto_unlocks() -> list:
    """Return a sorted list of wallet addresses that have Remember-Me tokens."""
    sessions_dir = get_sessions_dir()
    addresses = []
    try:
        for entry in os.scandir(sessions_dir):
            if entry.is_file() and entry.name.endswith(".auto_unlock"):
                addresses.append(entry.name[:-12])  # strip ".auto_unlock"
    except FileNotFoundError:
        pass
    addresses.sort()
    return addresses


# ─── Solana RPC Operations ─────────────────────────────────────────────────


def _get_client(rpc_url: str) -> SolanaClient:
    """Create a Solana RPC client."""
    return SolanaClient(rpc_url)


def get_sol_balance(rpc_url: str, address: str) -> float:
    """Get SOL balance for an address. Returns SOL (not lamports)."""
    client = _get_client(rpc_url)
    pubkey = Pubkey.from_string(address)
    resp = client.get_balance(pubkey, commitment=Confirmed)
    lamports = resp.value
    return lamports / LAMPORTS_PER_SOL


def send_sol(
    rpc_url: str,
    keypair: Keypair,
    to_address: str,
    amount_sol: float,
) -> str:
    """
    Send SOL to an address.

    Returns the transaction signature (base58) on success.
    Raises on failure.
    """
    client = _get_client(rpc_url)
    to_pubkey = Pubkey.from_string(to_address)
    lamports = int(amount_sol * LAMPORTS_PER_SOL)

    # Get a recent blockhash
    blockhash_resp = client.get_latest_blockhash(commitment=Confirmed)
    blockhash = blockhash_resp.value.blockhash

    # Build the transfer instruction
    ix = transfer(
        TransferParams(
            from_pubkey=keypair.pubkey(),
            to_pubkey=to_pubkey,
            lamports=lamports,
        )
    )

    # Build and sign the transaction
    msg = Message([ix], keypair.pubkey())
    tx = Transaction([keypair], msg, blockhash)

    # Serialize to bytes and encode as base58 for JSON-RPC
    tx_bytes = bytes(tx)
    tx_b58 = b58encode(tx_bytes).decode()

    # Send via direct JSON-RPC (avoids solana SDK version compatibility issues)
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [
            tx_b58,
            {"skipPreflight": False, "encoding": "base58", "preflightCommitment": "confirmed"},
        ],
    }

    with httpx.Client() as http_client:
        resp = http_client.post(rpc_url, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()

    if "error" in data:
        raise Exception(f"RPC error: {data['error']}")

    return str(data["result"])


def get_transaction_history(rpc_url: str, address: str, limit: int = 20) -> list:
    """
    Fetch recent transactions for an address with send/receive direction.

    Returns a list of dicts:
        { "signature": "...", "slot": int, "err": null|str, "timestamp": null|int,
          "amount": float, "type": "sent"|"received" }
    """
    pubkey = Pubkey.from_string(address)
    addr_str = str(pubkey)

    try:
        # Step 1: get recent signatures for this address
        client = _get_client(rpc_url)
        resp = client.get_signatures_for_address(
            pubkey,
            limit=limit,
            commitment=Confirmed,
        )
        signatures = [str(sig_info.signature) for sig_info in resp.value]
    except Exception:
        return []

    # Step 2: fetch each transaction in parallel to determine direction and amount
    txs = []

    # Shared client for connection pooling across all workers
    _shared_client = httpx.Client(timeout=httpx.Timeout(15.0))

    def _fetch_one(sig: str):
        """Fetch and parse a single transaction with retries. Returns dict or None."""
        last_error = None
        for attempt in range(3):
            try:
                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getTransaction",
                    "params": [sig, {"encoding": "jsonParsed", "commitment": "confirmed"}],
                }
                tx_resp = _shared_client.post(rpc_url, json=payload)
                tx_resp.raise_for_status()
                tx_data = tx_resp.json()

                if "error" in tx_data or not tx_data.get("result"):
                    # RPC returned an error (likely rate-limited) — retry after backoff
                    last_error = tx_data.get("error", "empty result")
                    time.sleep(1.0 * (attempt + 1))
                    continue

                result = tx_data["result"]
                meta = result.get("meta", {})
                transaction = result.get("transaction", {})
                message = transaction.get("message", {})
                account_keys = message.get("accountKeys", [])

                tx_err = meta.get("err")
                err_str = str(tx_err) if tx_err else None

                # Find our address index in account_keys
                our_index = None
                for i, acct in enumerate(account_keys):
                    acct_str = acct.get("pubkey", "") if isinstance(acct, dict) else str(acct)
                    if acct_str == addr_str:
                        our_index = i
                        break

                # Determine direction from pre/post balances
                pre_balances = meta.get("preBalances", [])
                post_balances = meta.get("postBalances", [])
                amount = 0
                tx_type = "received"

                if our_index is not None and our_index < len(pre_balances) and our_index < len(post_balances):
                    diff = pre_balances[our_index] - post_balances[our_index]
                    if diff > 0:
                        tx_type = "sent"
                        amount = diff / LAMPORTS_PER_SOL
                    elif diff < 0:
                        tx_type = "received"
                        amount = abs(diff) / LAMPORTS_PER_SOL

                return {
                    "signature": sig,
                    "slot": result.get("slot", 0),
                    "err": err_str,
                    "timestamp": result.get("blockTime"),
                    "amount": amount,
                    "type": tx_type,
                    "direction": tx_type,
                }
            except Exception as e:
                last_error = str(e)
                time.sleep(1.0 * (attempt + 1))
                continue

        # All 3 attempts failed
        return None

    # Fetch all transactions in parallel (moderate concurrency to avoid RPC rate limits)
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_fetch_one, sig): sig for sig in signatures}
        for future in as_completed(futures):
            result = future.result()
            if result is not None:
                txs.append(result)

    _shared_client.close()

    # Sort by slot (newest first) since parallel results are unordered
    txs.sort(key=lambda tx: tx.get("slot", 0), reverse=True)

    return txs


def validate_address(address: str) -> bool:
    """Validate a Solana base58 address."""
    try:
        Pubkey.from_string(address)
        return True
    except Exception:
        return False


# ─── Seed Phrase Encryption (same AES-256-GCM + Argon2id as private key) ───


def encrypt_seed_phrase(seed_phrase: str, password: str) -> dict:
    """Encrypt a BIP39 mnemonic string with the user's password.

    Returns the same dict structure as encrypt_private_key:
        { "ciphertext": (hex), "nonce": (hex), "salt": (hex) }
    """
    return encrypt_private_key(seed_phrase.encode("utf-8"), password)


def decrypt_seed_phrase(encrypted: dict, password: str) -> Optional[str]:
    """Decrypt a BIP39 mnemonic string. Returns str or None if password is wrong."""
    result = decrypt_private_key(encrypted, password)
    return result.decode("utf-8") if result else None
