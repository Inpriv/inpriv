// src/app.js — Zero Wallet application controller.
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// Wires the UI to the client-side crypto + server proxy. Holds the only
// in-memory copy of the unlocked keypair (cleared on lock / idle timeout).

import {
  generateMnemonic,
  validateMnemonic,
  keypairFromMnemonic,
  keypairFromBase58,
  keypairToBase58,
  addressFromPublicKey,
  validateAddress,
  encryptWallet,
  decryptWallet,
  PATH_PHANTOM,
  PATH_LEGACY_ZERO,
} from "./crypto.js";
import {
  putWallet,
  getWallet,
  listWallets,
  deleteWallet as idbDeleteWallet,
  kvGet,
  kvSet,
} from "./wallet-store.js";
import {
  getBalance,
  getSignaturesForAddress,
  getTransaction,
  getSolPrice,
  getConfig,
  LAMPORTS_PER_SOL,
} from "./rpc.js";
import { sendSol } from "./sign.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const LAMPORTS = LAMPORTS_PER_SOL;
const MIN_RENT_EXEMPT = 0.00089088; // Solana rent-exempt minimum
const TX_FEE = 0.000005; // base fee estimate
const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes idle

const PAGES_AUTHED = new Set([
  "page-dashboard",
  "page-send",
  "page-receive",
  "page-activity",
  "page-settings",
]);

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  // In-memory ONLY. Never persisted.
  keypair: null, // { secretKey, publicKey }
  address: null,
  mnemonic: null, // retained only during the create flow
  balance: 0,
  solPrice: 0,
  network: "mainnet-beta",
};

const createState = {
  mnemonic: "",
  words: [],
  confirmIndices: [],
  confirmAt: 0,
};

let _pollTimer = null;
let _idleTimer = null;
let _lastBalance = 0;

// ─── Tiny DOM helpers ────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (id) => document.getElementById(id);

function show(id) {
  $$(".page").forEach((p) => p.classList.remove("active"));
  const target = el(id);
  if (target) target.classList.add("active");

  const authed = PAGES_AUTHED.has(id);
  el("nav-bar").classList.toggle("show", authed);

  // nav active states
  $$(".nav-item").forEach((n) =>
    n.classList.toggle("active", n.dataset.nav === id)
  );

  // page-specific init
  if (id === "page-dashboard") onDashboard();
  if (id === "page-receive") onReceive();
  if (id === "page-activity") onActivity();
  if (id === "page-send") onSendPage();

  // polling only on dashboard
  if (id === "page-dashboard") startPolling();
  else stopPolling();
}

function showFieldError(id, msg) {
  const e = el(id);
  if (!e) return;
  if (msg !== undefined) e.textContent = msg;
  e.classList.add("show");
}
function clearFieldError(id) {
  el(id)?.classList.remove("show");
}

function toast(title, type = "success") {
  const t = el("toast");
  const icon = el("toast-icon");
  el("toast-title").textContent = title;
  t.classList.remove("error");
  icon.textContent = type === "error" ? "error" : "check_circle";
  if (type === "error") t.classList.add("error");
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3200);
}

function openDialog(id) {
  el(id).classList.add("active");
}
function closeDialog(id) {
  el(id).classList.remove("active");
}

function fmtAddr(a, head = 4, tail = 4) {
  if (!a) return "—";
  return a.length > head + tail + 2 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}
function fmtTimeAgo(ts) {
  if (!ts) return "";
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
}

// ─── Ripple effect ───────────────────────────────────────────────────────────

function attachRipple(root) {
  root.addEventListener("click", (e) => {
    const target = e.target.closest(
      ".btn, .fab, .icon-btn, .nav-item, .quick-action, .seed-option, .segmented button, .max-chip"
    );
    if (!target) return;
    const r = target.getBoundingClientRect();
    const span = document.createElement("span");
    span.className = "ripple";
    const size = Math.max(r.width, r.height);
    span.style.width = span.style.height = size + "px";
    span.style.left = e.clientX - r.left - size / 2 + "px";
    span.style.top = e.clientY - r.top - size / 2 + "px";
    target.appendChild(span);
    setTimeout(() => span.remove(), 600);
  });
}

// ─── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  el("theme-icon").textContent = theme === "light" ? "light_mode" : "dark_mode";
  const sw = el("pref-light");
  if (sw) sw.checked = theme === "light";
}

async function initTheme() {
  const saved = await kvGet("theme", null);
  let theme = saved;
  if (!theme) {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  applyTheme(theme);
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  const next = current === "light" ? "dark" : "light";
  applyTheme(next);
  await kvSet("theme", next);
}

// ─── Session helpers ─────────────────────────────────────────────────────────

function setUnlocked(keypair, mnemonic = null) {
  state.keypair = keypair;
  state.address = addressFromPublicKey(keypair.publicKey);
  state.mnemonic = mnemonic;
  resetIdle();
}

function lock() {
  state.keypair = null;
  state.address = null;
  state.mnemonic = null;
  state.balance = 0;
  _lastBalance = 0;
  stopPolling();
  stopIdle();
}

function resetIdle() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (state.keypair) {
      toast("Wallet auto-locked after inactivity");
      lock();
      show("page-unlock");
      refreshUnlockTarget();
    }
  }, AUTO_LOCK_MS);
}
function stopIdle() {
  clearTimeout(_idleTimer);
  _idleTimer = null;
}
["mousemove", "keydown", "touchstart", "click"].forEach((ev) =>
  document.addEventListener(ev, () => state.keypair && resetIdle())
);

async function pickStartPage() {
  const wallets = await listWallets();
  const last = await kvGet("lastAddress", null);
  if (wallets.length === 0) {
    show("page-welcome");
    return;
  }
  // If we have wallets, go to unlock screen.
  const target = last && wallets.some((w) => w.address === last) ? last : wallets[0].address;
  await kvSet("lastAddress", target);
  state.address = null; // not unlocked yet
  prepareUnlockScreen(target);
  show("page-unlock");
}

function prepareUnlockScreen(address) {
  el("unlock-address-pill").textContent = fmtAddr(address, 6, 6);
  el("unlock-password").value = "";
  clearFieldError("unlock-error");
  el("unlock-submit").dataset.address = address;
}

function refreshUnlockTarget() {
  listWallets().then((wallets) => {
    if (wallets.length === 0) {
      show("page-welcome");
      return;
    }
    const target = wallets[wallets.length - 1].address;
    prepareUnlockScreen(target);
  });
}

// ─── Create flow ─────────────────────────────────────────────────────────────

async function startCreate() {
  createState.mnemonic = generateMnemonic();
  createState.words = createState.mnemonic.split(" ");
  renderSeedGrid();
  el("seed-saved").checked = false;
  el("create-continue").disabled = true;
  stepCreate(1);
  show("page-create");
}

function renderSeedGrid() {
  el("seed-grid").innerHTML = createState.words
    .map(
      (w, i) =>
        `<div class="seed-word"><span class="idx">${i + 1}</span><span class="word">${w}</span></div>`
    )
    .join("");
}

function stepCreate(n) {
  for (let i = 1; i <= 3; i++) el(`create-step-${i}`).classList.add("hidden");
  el(`create-step-${n}`).classList.remove("hidden");
  $$("#create-stepper .dot").forEach((d, i) => d.classList.toggle("active", i < n));
}

function beginConfirm() {
  // pick 3 distinct random indices
  const idxs = [];
  while (idxs.length < 3) {
    const r = Math.floor(Math.random() * createState.words.length);
    if (!idxs.includes(r)) idxs.push(r);
  }
  createState.confirmIndices = idxs;
  createState.confirmAt = 0;
  stepCreate(2);
  renderConfirmWord();
}

function renderConfirmWord() {
  const at = createState.confirmAt;
  const wordIdx = createState.confirmIndices[at];
  el("confirm-instruction").textContent = `Select word #${wordIdx + 1}`;
  const correct = createState.words[wordIdx];
  const opts = new Set([correct]);
  while (opts.size < 4) opts.add(createState.words[Math.floor(Math.random() * createState.words.length)]);
  const shuffled = Array.from(opts).sort(() => Math.random() - 0.5);
  el("seed-options").innerHTML = shuffled
    .map((w) => `<button class="seed-option" data-word="${w}">${w}</button>`)
    .join("");
  el("confirm-prev").disabled = at === 0;
  el("confirm-next").disabled = true;
  el("confirm-next").textContent = at === 2 ? "Finish" : "Next";
}

function selectConfirmOption(btn) {
  $$("#seed-options .seed-option").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  el("confirm-next").dataset.selected = btn.dataset.word;
  el("confirm-next").disabled = false;
}

function nextConfirm() {
  const at = createState.confirmAt;
  const wordIdx = createState.confirmIndices[at];
  const correct = createState.words[wordIdx];
  const selected = el("confirm-next").dataset.selected;

  if (selected !== correct) {
    $$("#seed-options .seed-option").forEach((b) => {
      if (b.dataset.word === selected) b.classList.add("wrong");
    });
    $$("#seed-options .seed-option").forEach((b) => {
      if (b.dataset.word === correct) b.classList.add("correct");
    });
    toast("Incorrect word — try again", "error");
    el("confirm-next").disabled = true;
    return;
  }

  $$("#seed-options .seed-option").forEach((b) => {
    if (b.dataset.word === correct) b.classList.add("correct");
  });

  setTimeout(() => {
    if (createState.confirmAt >= 2) {
      stepCreate(3);
    } else {
      createState.confirmAt++;
      renderConfirmWord();
    }
  }, 350);
}

function prevConfirm() {
  if (createState.confirmAt > 0) {
    createState.confirmAt--;
    renderConfirmWord();
  }
}

function passwordScore(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) || /[^a-zA-Z0-9]/.test(pw)) s++;
  return s;
}

function paintStrength(pwInputId, barId, textId) {
  const pw = el(pwInputId).value;
  const score = passwordScore(pw);
  const labels = ["", "Weak", "Fair", "Good", "Strong"];
  const classes = ["", "weak", "medium", "medium", "strong"];
  $`#${barId}`; // noop guard
  el(barId).querySelectorAll("span").forEach((seg, i) => {
    seg.className = "";
    if (i < score) seg.classList.add(classes[score]);
  });
  const txt = el(textId);
  txt.textContent = pw ? labels[score] : "";
  txt.className = "strength-text " + classes[score];
}

function checkCreatePasswords() {
  const pw = el("create-password").value;
  const cpw = el("create-password-confirm").value;
  clearFieldError("create-password-error");
  el("create-finish").disabled = true;
  if (pw.length < 8 || cpw.length < 8) return;
  if (pw !== cpw) {
    showFieldError("create-password-error", "Passwords do not match");
    return;
  }
  el("create-finish").disabled = false;
}

async function finishCreate() {
  const pw = el("create-password").value;
  const btn = el("create-finish");
  btn.disabled = true;
  btn.textContent = "Encrypting…";
  clearFieldError("create-error");

  try {
    const keypair = keypairFromMnemonic(createState.mnemonic, PATH_PHANTOM);
    const address = addressFromPublicKey(keypair.publicKey);
    const envelope = await encryptWallet(
      { secretKey: keypair.secretKey, mnemonic: createState.mnemonic },
      pw,
      address
    );
    await putWallet(envelope);
    await kvSet("lastAddress", address);
    setUnlocked(keypair, createState.mnemonic);
    // wipe the transient mnemonic from the create-flow object
    createState.mnemonic = "";
    createState.words = [];
    toast("Wallet created");
    show("page-dashboard");
  } catch (e) {
    showFieldError("create-error", "Failed to create wallet: " + e.message);
    btn.disabled = false;
    btn.textContent = "Create wallet";
  }
}

// ─── Import flow ─────────────────────────────────────────────────────────────

function switchImportType(type) {
  $$("#import-segmented button").forEach((b) =>
    b.classList.toggle("active", b.dataset.type === type)
  );
  el("import-mnemonic-field").classList.toggle("hidden", type !== "mnemonic");
  el("import-privatekey-field").classList.toggle("hidden", type !== "privatekey");
  checkImportForm();
}

function checkImportForm() {
  clearFieldError("import-error");
  el("import-finish").disabled = true;
  const type = $$("#import-segmented button.active")[0]?.dataset.type;
  const value =
    type === "mnemonic"
      ? el("import-mnemonic").value.trim()
      : el("import-privatekey").value.trim();
  const pw = el("import-password").value;
  const cpw = el("import-password-confirm").value;
  if (!value || pw.length < 8 || cpw.length < 8) return;
  if (pw !== cpw) {
    el("import-error").textContent = "Passwords do not match";
    showFieldError("import-error");
    return;
  }
  el("import-finish").disabled = false;
}

async function finishImport() {
  const type = $$("#import-segmented button.active")[0]?.dataset.type;
  const value =
    type === "mnemonic"
      ? el("import-mnemonic").value.trim()
      : el("import-privatekey").value.trim();
  const pw = el("import-password").value;
  const legacy = el("import-legacy").checked;
  const path = legacy ? PATH_LEGACY_ZERO : PATH_PHANTOM;

  const btn = el("import-finish");
  btn.disabled = true;
  btn.textContent = "Importing…";
  clearFieldError("import-error");

  try {
    let keypair, mnemonic = null;
    if (type === "mnemonic") {
      const norm = value.toLowerCase().replace(/\s+/g, " ").trim();
      if (!validateMnemonic(norm)) throw new Error("Invalid recovery phrase");
      keypair = keypairFromMnemonic(norm, path);
      mnemonic = norm;
    } else {
      keypair = keypairFromBase58(value);
    }
    const address = addressFromPublicKey(keypair.publicKey);
    const envelope = await encryptWallet(
      { secretKey: keypair.secretKey, mnemonic },
      pw,
      address
    );
    await putWallet(envelope);
    await kvSet("lastAddress", address);
    setUnlocked(keypair, mnemonic);
    el("import-mnemonic").value = "";
    el("import-privatekey").value = "";
    toast(legacy ? "Imported (legacy path)" : "Wallet imported");
    show("page-dashboard");
  } catch (e) {
    el("import-error").textContent = e.message || "Import failed";
    showFieldError("import-error");
    btn.disabled = false;
    btn.textContent = "Import wallet";
  }
}

// ─── Unlock ──────────────────────────────────────────────────────────────────

async function doUnlock() {
  const address = el("unlock-submit").dataset.address;
  const pw = el("unlock-password").value;
  if (!address || !pw) return;
  clearFieldError("unlock-error");
  el("unlock-submit").textContent = "Unlocking…";
  try {
    const envelope = await getWallet(address);
    if (!envelope) {
      throw new Error("Wallet not found");
    }
    const secrets = await decryptWallet(envelope, pw);
    if (!secrets) throw new Error("bad-password");
    const keypair = { secretKey: secrets.secretKey, publicKey: secrets.secretKey.subarray(32) };
    const verified = addressFromPublicKey(keypair.publicKey);
    if (verified !== address) throw new Error("address mismatch");
    await kvSet("lastAddress", address);
    setUnlocked(keypair, secrets.mnemonic);
    el("unlock-password").value = "";
    toast("Wallet unlocked");
    show("page-dashboard");
  } catch (e) {
    showFieldError("unlock-error", e.message === "bad-password" ? "Incorrect password" : "Unlock failed");
    el("unlock-password").value = "";
  } finally {
    el("unlock-submit").textContent = "Unlock";
  }
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function onDashboard() {
  if (!state.address) return;
  // paint address immediately
  el("dash-address-text").textContent = fmtAddr(state.address, 4, 6);
  el("settings-address").textContent = state.address;
  state.solPrice = await getSolPrice();
  await loadBalance();
  loadDashActivity();
}

async function loadBalance() {
  if (!state.address) return;
  try {
    const bal = await getBalance(state.address);
    state.balance = bal;
    _lastBalance = bal;
    el("balance-value").textContent = bal < 0.01 ? bal.toFixed(6) : bal.toFixed(4);
    const usd = bal * state.solPrice;
    el("balance-usd").innerHTML =
      `<span class="material-symbols-rounded" style="font-size:16px">trending_up</span> $${usd.toFixed(2)} USD`;
  } catch (e) {
    el("balance-value").textContent = "—";
  }
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(async () => {
    if (state.address && el("page-dashboard").classList.contains("active")) {
      await loadBalance();
      loadDashActivity(true);
    }
  }, 12000);
}
function stopPolling() {
  clearInterval(_pollTimer);
  _pollTimer = null;
}

async function loadDashActivity(silent = false) {
  if (!state.address) return;
  const container = el("dash-activity");
  if (!silent) {
    container.innerHTML =
      '<div class="activity-item"><div class="skeleton skeleton-circle" style="width:40px;height:40px"></div><div style="flex:1"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line" style="width:60%"></div></div></div>';
  }
  try {
    const txs = await fetchActivity(state.address, 5);
    if (txs.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><span class="material-symbols-rounded">inbox</span><h3>No transactions yet</h3><p>Send or receive SOL to get started</p></div>';
      return;
    }
    container.innerHTML = txs.map(renderActivityItem).join("");
  } catch {
    container.innerHTML =
      '<div class="empty-state"><h3>Could not load activity</h3></div>';
  }
}

// ─── Activity ────────────────────────────────────────────────────────────────

async function fetchActivity(address, limit = 20) {
  const sigs = await getSignaturesForAddress(address, limit);
  const out = [];
  for (const s of sigs) {
    let direction = "received";
    let amount = 0;
    try {
      const tx = await getTransaction(s.signature);
      if (tx && tx.meta && tx.transaction && tx.transaction.message) {
        const accountKeys = tx.transaction.message.accountKeys.map((k) =>
          typeof k === "string" ? k : k.pubkey
        );
        const pre = tx.meta.preBalances;
        const post = tx.meta.postBalances;
        const idx = accountKeys.indexOf(address);
        if (idx >= 0 && pre && post) {
          const diff = pre[idx] - post[idx];
          if (diff > 0) {
            direction = "sent";
            amount = diff / LAMPORTS;
          } else if (diff < 0) {
            direction = "received";
            amount = Math.abs(diff) / LAMPORTS;
          }
        }
      }
    } catch {
      /* partial is fine */
    }
    out.push({
      signature: s.signature,
      direction,
      amount,
      timestamp: s.blockTime,
      err: s.err,
    });
  }
  return out;
}

function renderActivityItem(tx) {
  const sent = tx.direction === "sent";
  const sign = sent ? "−" : "+";
  const amtClass = sent ? "negative" : "positive";
  const status = tx.err ? "failed" : "confirmed";
  return `<div class="activity-item">
    <div class="activity-icon ${tx.direction}"><span class="material-symbols-rounded">${sent ? "north_east" : "south_west"}</span></div>
    <div class="activity-info">
      <div class="activity-title">${sent ? "Sent" : "Received"}</div>
      <div class="activity-detail">${fmtAddr(tx.signature, 6, 6)} · ${fmtTimeAgo(tx.timestamp)}</div>
    </div>
    <div class="activity-amount">
      <div class="amt ${amtClass}">${sign}${tx.amount.toFixed(4)} SOL</div>
      <span class="activity-status ${status}">${status}</span>
    </div>
  </div>`;
}

async function onActivity() {
  if (!state.address) return;
  const container = el("activity-list");
  container.innerHTML =
    '<div class="activity-item"><div class="skeleton skeleton-circle" style="width:40px;height:40px"></div><div style="flex:1"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line" style="width:60%"></div></div></div>';
  try {
    const txs = await fetchActivity(state.address, 20);
    if (txs.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><span class="material-symbols-rounded">inbox</span><h3>No transactions yet</h3></div>';
      return;
    }
    container.innerHTML = txs.map(renderActivityItem).join("");
  } catch {
    container.innerHTML = '<div class="empty-state"><h3>Could not load activity</h3></div>';
  }
}

// ─── Send ────────────────────────────────────────────────────────────────────

async function onSendPage() {
  el("send-balance").textContent = (state.balance || 0).toFixed(6) + " SOL";
  el("send-address").value = "";
  el("send-amount").value = "";
  clearFieldError("send-error");
  el("send-review").disabled = true;
  el("send-usd").textContent = "—";
  if (!state.balance) await loadBalance();
  el("send-balance").textContent = state.balance.toFixed(6) + " SOL";
}

function checkSendForm() {
  const addr = el("send-address").value.trim();
  const amt = parseFloat(el("send-amount").value) || 0;
  clearFieldError("send-error");
  el("send-review").disabled = true;
  if (!addr || amt <= 0) return;
  if (!validateAddress(addr)) {
    el("send-error").textContent = "Invalid recipient address";
    showFieldError("send-error");
    return;
  }
  if (amt + TX_FEE > state.balance) {
    el("send-error").textContent = "Insufficient balance (including network fee)";
    showFieldError("send-error");
    return;
  }
  el("send-review").disabled = false;
  updateSendUsd();
}

function setMaxAmount() {
  const max = Math.max(0, state.balance - TX_FEE);
  el("send-amount").value = max.toFixed(6);
  checkSendForm();
}

function updateSendUsd() {
  const amt = parseFloat(el("send-amount").value) || 0;
  el("send-usd").textContent = "$" + (amt * state.solPrice).toFixed(2);
}

function openSendReview() {
  el("confirm-amount").textContent = parseFloat(el("send-amount").value).toFixed(6) + " SOL";
  el("confirm-to").textContent = el("send-address").value.trim();
  clearFieldError("confirm-error");
  openDialog("dialog-send");
}

async function confirmAndSend() {
  const addr = el("send-address").value.trim();
  const amt = parseFloat(el("send-amount").value);
  const btn = el("confirm-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  clearFieldError("confirm-error");
  try {
    const sig = await sendSol(state.keypair, addr, amt);
    closeDialog("dialog-send");
    el("success-sig").textContent = fmtAddr(sig, 8, 8);
    openDialog("dialog-success");
    el("send-address").value = "";
    el("send-amount").value = "";
    el("send-review").disabled = true;
    setTimeout(loadBalance, 2500);
  } catch (e) {
    el("confirm-error").textContent = e.message || "Transaction failed";
    showFieldError("confirm-error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirm & send";
  }
}

// ─── Receive ─────────────────────────────────────────────────────────────────

async function onReceive() {
  if (!state.address) return;
  el("receive-address-text").textContent = fmtAddr(state.address, 6, 6);
  // Generate QR locally (no third-party leak)
  try {
    const QRCode = (await import("qrcode")).default;
    const dataUrl = await QRCode.toDataURL(state.address, {
      margin: 1,
      width: 200,
      color: { dark: "#13140E", light: "#FFFFFF" },
    });
    el("receive-qr").src = dataUrl;
  } catch {
    el("receive-qr").alt = "QR unavailable";
  }
}

// ─── Copy ────────────────────────────────────────────────────────────────────

async function copyAddress() {
  if (!state.address) return;
  try {
    await navigator.clipboard.writeText(state.address);
    toast("Address copied");
  } catch {
    toast("Copy failed", "error");
  }
}

// ─── Export / Reveal ─────────────────────────────────────────────────────────

async function doExport() {
  const pw = el("export-password").value;
  clearFieldError("export-error");
  if (!state.address) return;
  const env = await getWallet(state.address);
  if (!env) return;
  const secrets = await decryptWallet(env, pw);
  if (!secrets) {
    showFieldError("export-error", "Incorrect password");
    return;
  }
  const b58 = keypairToBase58(secrets.secretKey);
  el("export-result").textContent = b58;
  el("export-result").classList.remove("hidden");
  el("export-reveal").style.display = "none";
  toast("Private key revealed — copy it now");
}

async function doReveal() {
  const pw = el("reveal-password").value;
  clearFieldError("reveal-error");
  if (!state.address) return;
  const env = await getWallet(state.address);
  if (!env) return;
  const secrets = await decryptWallet(env, pw);
  if (!secrets) {
    showFieldError("reveal-error", "Incorrect password");
    return;
  }
  const out = el("reveal-result");
  if (secrets.mnemonic) {
    const words = secrets.mnemonic.split(" ");
    out.innerHTML =
      '<div class="seed-grid" style="margin-top:12px">' +
      words
        .map(
          (w, i) =>
            `<div class="seed-word"><span class="idx">${i + 1}</span><span class="word">${w}</span></div>`
        )
        .join("") +
      "</div>";
  } else {
    out.innerHTML =
      '<div class="result-box">This wallet has no stored recovery phrase (imported via private key). Use "Export private key" instead.</div>';
  }
  el("reveal-go").style.display = "none";
  toast("Recovery phrase revealed");
}

// ─── Delete / Close account ──────────────────────────────────────────────────

async function doDelete() {
  const pw = el("delete-password").value;
  clearFieldError("delete-error");
  if (!state.address) return;
  const env = await getWallet(state.address);
  if (!env) return;
  const secrets = await decryptWallet(env, pw);
  if (!secrets) {
    showFieldError("delete-error", "Incorrect password");
    return;
  }
  await idbDeleteWallet(state.address);
  lock();
  closeDialog("dialog-delete");
  toast("Wallet deleted from this device");
  await pickStartPage();
}

async function openCloseAccount() {
  el("close-balance").textContent = state.balance.toFixed(6) + " SOL";
  el("close-receive").textContent = Math.max(0, state.balance - TX_FEE).toFixed(6) + " SOL";
  el("close-dest").value = "";
  clearFieldError("close-error");
  openDialog("dialog-close-acct");
}

async function doCloseAccount() {
  const dest = el("close-dest").value.trim();
  if (!validateAddress(dest)) {
    el("close-error").textContent = "Invalid destination address";
    showFieldError("close-error");
    return;
  }
  const amount = state.balance - TX_FEE;
  if (amount <= 0) {
    el("close-error").textContent = "Balance too low to cover the fee";
    showFieldError("close-error");
    return;
  }
  clearFieldError("close-error");
  try {
    await sendSol(state.keypair, dest, amount);
    closeDialog("dialog-close-acct");
    toast("Funds sent — account drained");
    await loadBalance();
    onDashboard();
  } catch (e) {
    el("close-error").textContent = e.message || "Failed to close account";
    showFieldError("close-error");
  }
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireEvents() {
  // global nav via data-nav
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      if (!state.keypair) return;
      show(nav.dataset.nav);
      return;
    }
    const back = e.target.closest("[data-back]");
    if (back) {
      show(back.dataset.back);
      return;
    }
    const close = e.target.closest("[data-close]");
    if (close) {
      closeDialog(close.dataset.close);
      return;
    }
  });

  // ripple
  attachRipple(document);

  // app bar / theme
  el("theme-toggle").addEventListener("click", toggleTheme);
  el("pref-light").addEventListener("change", (e) => {
    applyTheme(e.target.checked ? "light" : "dark");
    kvSet("theme", e.target.checked ? "light" : "dark");
  });

  // welcome
  el("welcome-create").addEventListener("click", startCreate);
  el("welcome-import").addEventListener("click", () => show("page-import"));
  el("open-tos").addEventListener("click", () => openDialog("dialog-tos"));
  el("open-privacy").addEventListener("click", () => openDialog("dialog-privacy"));

  // create
  el("seed-saved").addEventListener("change", (e) => {
    el("create-continue").disabled = !e.target.checked;
  });
  el("create-continue").addEventListener("click", beginConfirm);
  el("copy-seed").addEventListener("click", () => {
    navigator.clipboard.writeText(createState.mnemonic).then(
      () => toast("Phrase copied — clear it after saving"),
      () => toast("Copy failed", "error")
    );
  });
  el("seed-options").addEventListener("click", (e) => {
    const b = e.target.closest(".seed-option");
    if (b) selectConfirmOption(b);
  });
  el("confirm-next").addEventListener("click", nextConfirm);
  el("confirm-prev").addEventListener("click", prevConfirm);

  // create password
  ["create-password", "create-password-confirm"].forEach((id) =>
    el(id).addEventListener("input", () => {
      checkCreatePasswords();
    })
  );
  el("create-password").addEventListener("input", () =>
    paintStrength("create-password", "create-strength", "create-strength-text")
  );
  el("create-finish").addEventListener("click", finishCreate);

  // import
  $$("#import-segmented button").forEach((b) =>
    b.addEventListener("click", () => switchImportType(b.dataset.type))
  );
  ["import-mnemonic", "import-privatekey", "import-password", "import-password-confirm"].forEach(
    (id) => el(id).addEventListener("input", checkImportForm)
  );
  el("import-password").addEventListener("input", () =>
    paintStrength("import-password", "import-strength", "import-strength-text")
  );
  el("import-finish").addEventListener("click", finishImport);

  // unlock
  el("unlock-submit").addEventListener("click", doUnlock);
  el("unlock-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doUnlock();
  });
  el("unlock-different").addEventListener("click", () => show("page-welcome"));

  // dashboard
  el("dash-address").addEventListener("click", copyAddress);
  el("dash-copy").addEventListener("click", copyAddress);

  // send
  ["send-address", "send-amount"].forEach((id) =>
    el(id).addEventListener("input", checkSendForm)
  );
  el("send-amount").addEventListener("input", updateSendUsd);
  el("send-max").addEventListener("click", setMaxAmount);
  el("send-review").addEventListener("click", openSendReview);
  el("confirm-send").addEventListener("click", confirmAndSend);

  // receive
  el("receive-address-pill").addEventListener("click", copyAddress);
  el("receive-copy").addEventListener("click", copyAddress);

  // settings
  el("settings-copy").addEventListener("click", copyAddress);
  el("settings-export").addEventListener("click", () => {
    el("export-password").value = "";
    el("export-result").classList.add("hidden");
    el("export-reveal").style.display = "";
    clearFieldError("export-error");
    openDialog("dialog-export");
  });
  el("export-reveal").addEventListener("click", doExport);
  el("settings-reveal").addEventListener("click", () => {
    el("reveal-password").value = "";
    el("reveal-result").innerHTML = "";
    el("reveal-go").style.display = "";
    clearFieldError("reveal-error");
    openDialog("dialog-reveal");
  });
  el("reveal-go").addEventListener("click", doReveal);
  el("settings-lock").addEventListener("click", async () => {
    lock();
    toast("Wallet locked");
    await pickStartPage();
  });
  el("settings-delete").addEventListener("click", () => {
    el("delete-password").value = "";
    clearFieldError("delete-error");
    openDialog("dialog-delete");
  });
  el("delete-confirm").addEventListener("click", doDelete);
  el("settings-close").addEventListener("click", openCloseAccount);
  el("close-go").addEventListener("click", doCloseAccount);

  // dialog overlay click-to-close
  $$(".dialog-overlay").forEach((ov) =>
    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.remove("active");
    })
  );
  // escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      $$(".dialog-overlay.active").forEach((d) => d.classList.remove("active"));
  });

  // network chip
  getConfig().then((cfg) => {
    el("network-chip").textContent = cfg.network || "mainnet";
  });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  wireEvents();
  await initTheme();
  await pickStartPage();
}

boot().catch((e) => {
  console.error("Zero boot failed", e);
});
