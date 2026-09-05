// Inpriv ID — account UI logic (login/register/2FA/panel).
/* global document, localStorage, fetch, location, sessionStorage, navigator */

const API = ""; // same origin

// ── state ────────────────────────────────────────────────────────────────────
let token = localStorage.getItem("inpriv_id_token") || null;
let user = null;
let mfaToken = null;
let vault = { theme: null, avatar: "initials", privacy: { nick: true, prompt: true, vault: true, log: true } };
let recoveryCodes = [];

// ── helpers ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

async function api(path, body, method = "POST") {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  // token rotation: server returns the fresh token in a header
  const rotated = res.headers.get("X-Inpriv-Token");
  if (rotated) {
    token = rotated;
    localStorage.setItem("inpriv_id_token", rotated);
  }
  // 401 always throws (auth failure = an error the caller must show);
  // deleting the token happens only when the server confirms the session
  // is really gone, never as a side effect of a wrong-password attempt.
  if (res.status === 401) {
    if (token && data && data.error === "unauthorized") {
      token = null;
      localStorage.removeItem("inpriv_id_token");
    }
    throw new Error(data.error || "unauthorized");
  }
  if (!res.ok) throw new Error(data.error || "request failed");
  if (data.token) {
    token = data.token;
    localStorage.setItem("inpriv_id_token", data.token);
  }
  return data;
}

function toast(msg, ok = true) {
  const t = $("toast");
  $("toastMsg").textContent = msg;
  $("toastIcon").textContent = ok ? "check_circle" : "error";
  t.classList.toggle("err", !ok);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}

function err(msg) {
  const e = $("formErr");
  e.textContent = msg;
  e.classList.add("show");
}

function clearErr() {
  $("formErr").classList.remove("show");
}

// ── theme ────────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("inpriv-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
function setTheme(th) {
  document.documentElement.dataset.theme = th;
  localStorage.setItem("inpriv-theme", th);
  $("themeBtn").firstElementChild.textContent = th === "dark" ? "dark_mode" : "light_mode";
  syncSeg("thDark", "thLight", th === "dark");
}
$("themeBtn").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  saveVault();
});

function syncSeg(a, b, aOn) {
  $(a).classList.toggle("on", aOn);
  $(b).classList.toggle("on", !aOn);
}

// ── view switching ───────────────────────────────────────────────────────────
function show(view) {
  $("authView").hidden = view !== "auth";
  $("panelView").hidden = view !== "panel";
}

// auth tabs
$("segLogin").addEventListener("click", () => switchAuth("login"));
$("segRegister").addEventListener("click", () => switchAuth("register"));
function switchAuth(mode) {
  clearErr();
  $("segLogin").classList.toggle("on", mode === "login");
  $("segRegister").classList.toggle("on", mode === "register");
  $("segLogin").setAttribute("aria-selected", mode === "login");
  $("segRegister").setAttribute("aria-selected", mode === "register");
  $("loginForm").hidden = mode !== "login";
  $("regForm").hidden = mode !== "register";
  $("mfaForm").hidden = true;
  $("mfaRecoveryForm").hidden = true;
  $("authTitle").textContent = mode === "login" ? "Welcome back" : "Create your account";
  $("authSub").textContent = mode === "login" ? "One private account for every Inpriv tool." : "Get your personal @inpriv.xyz email address. Send and receive private mail.";
}

// tabs
document.querySelectorAll("#tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    document.querySelectorAll(".tabview").forEach((v) => v.classList.remove("on"));
    $("tab-" + b.dataset.tab).classList.add("on");
  });
});

// ── auth flows ───────────────────────────────────────────────────────────────
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErr();
  const btn = $("loginBtn");
  btn.disabled = true;
  try {
    const out = await api("/api/login", {
      login: $("loginEmail").value.trim(),
      password: $("loginPass").value,
    });
    if (out.mfa_required) {
      mfaToken = out.mfa_token;
      $("loginForm").hidden = true;
      $("mfaForm").hidden = false;
      $("mfaCode").focus();
    } else {
      user = out.user;
      await enterPanel();
    }
  } catch (ex) {
    err(ex.message);
  } finally {
    btn.disabled = false;
  }
});

$("mfaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErr();
  try {
    const out = await api("/api/login/2fa", { mfa_token: mfaToken, code: $("mfaCode").value });
    user = out.user;
    await enterPanel();
  } catch (ex) {
    err(ex.message);
  }
});

$("mfaRecoverLink").addEventListener("click", (e) => {
  e.preventDefault();
  $("mfaForm").hidden = true;
  $("mfaRecoveryForm").hidden = false;
});

$("mfaRecoveryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErr();
  try {
    const out = await api("/api/login/2fa", { mfa_token: mfaToken, recovery: $("mfaRecovery").value });
    user = out.user;
    await enterPanel();
  } catch (ex) {
    err(ex.message);
  }
});

$("regForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErr();
  const btn = $("regBtn");
  btn.disabled = true;
  try {
    const out = await api("/api/register", {
      username: $("regId").value.trim(),
      nick: $("regNick").value.trim(),
      password: $("regPass").value,
    });
    user = out.user;
    toast("Account created — welcome to Inpriv!");
    await enterPanel();
  } catch (ex) {
    err(ex.message);
  } finally {
    btn.disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", {}); } catch {}
  token = null;
  localStorage.removeItem("inpriv_id_token");
  location.reload();
});

// ── panel ────────────────────────────────────────────────────────────────────
async function enterPanel() {
  show("panel");
  await refreshMe();
  await loadVault();
  renderProfile();
  loadSessions();
  loadEvents();
  loadSettings();
  loadServices();
}

// Quick Unlock (master-password bypass) — stored server-side per account so
// it governs every device, not just this browser. Turning it off also wipes
// the wrapped device keys so nothing can decrypt without the master password.
let quickUnlock = true;
async function loadSettings() {
  try {
    const out = await api("/api/settings", null, "GET");
    quickUnlock = !!(out.settings && out.settings.quick_unlock);
  } catch {
    quickUnlock = true; // endpoint unavailable → keep the historical default
  }
  setSwitch("swQuickUnlock", quickUnlock);
}
function bindQuickUnlock() {
  const el = $("swQuickUnlock");
  if (!el) return;
  const flip = async () => {
    const on = !el.classList.contains("on");
    setSwitch("swQuickUnlock", on);
    try {
      await api("/api/settings", { quick_unlock: on });
      quickUnlock = on;
      if (!on) {
        // remove wrapped device keys on every service + the ID-side blob
        try { await api("/api/quick-unlock/clear", {}); } catch {}
        toast("Quick Unlock off — master password required everywhere");
      } else {
        toast("Quick Unlock on — sign in once per service to re-enable it");
      }
    } catch (ex) {
      setSwitch("swQuickUnlock", quickUnlock); // revert
      toast(ex.message, false);
    }
  };
  el.addEventListener("click", flip);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
  });
}
bindQuickUnlock();

async function refreshMe() {
  try {
    const out = await api("/api/me", null, "GET");
    user = out.user;
  } catch {
    show("auth");
    throw new Error("signed out");
  }
}

function initials(nick) {
  return String(nick || "?").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

function renderProfile() {
  const displayName = user.nick || user.username || "user";
  if (vault.avatar === "leaf") {
    $("avatar").innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>';
  } else {
    $("avatar").textContent = initials(displayName);
  }
  $("pNick").textContent = displayName;
  $("pEmail").textContent = user.inpriv_email || user.email || (user.username + "@inpriv.xyz");
  
  const hasRecovery = !!user.recovery_email;
  $("badgeVerified").hidden = !user.email_verified;
  $("badgeUnverified").hidden = !hasRecovery || !!user.email_verified;
  $("badge2fa").hidden = !user.totp_enabled;
  
  $("nickInput").value = user.nick || "";
  $("recoveryInput").value = user.recovery_email || "";
  
  const verifySec = $("verifySection");
  if (verifySec) {
    verifySec.style.display = (hasRecovery && !user.email_verified) ? "flex" : "none";
  }

  $("twoFAOffUI").hidden = user.totp_enabled;
  $("twoFAOnUI").hidden = !user.totp_enabled;

  // privacy switches
  setSwitch("swNick", vault.privacy.nick);
  setSwitch("swPrompt", vault.privacy.prompt);
  setSwitch("swVault", vault.privacy.vault);
  setSwitch("swLog", vault.privacy.log);
  syncSeg("thDark", "thLight", (vault.theme || document.documentElement.dataset.theme) === "dark");
  syncSeg("avInitials", "avLeaf", vault.avatar === "initials");
}

// vault (server-sealed)
async function loadVault() {
  try {
    const out = await api("/api/vault/get", null, "GET");
    if (out.vault) {
      const parsed = JSON.parse(out.vault);
      vault = { ...vault, ...parsed, privacy: { ...vault.privacy, ...(parsed.privacy || {}) } };
    }
  } catch {}
}

async function saveVault() {
  if (!vault.privacy.vault) return;
  try {
    vault.theme = document.documentElement.dataset.theme;
    await api("/api/vault/set", { vault });
  } catch {}
}

// profile: nick
$("nickSave").addEventListener("click", async () => {
  try {
    const out = await api("/api/profile", { nick: $("nickInput").value.trim() });
    user = out.user;
    renderProfile();
    toast("Nickname saved");
  } catch (ex) {
    toast(ex.message, false);
  }
});

// profile: recovery email
$("recoverySaveBtn").addEventListener("click", async () => {
  try {
    const out = await api("/api/recovery-email/set", { recovery_email: $("recoveryInput").value.trim() });
    user = out.user;
    renderProfile();
    toast(user.recovery_email ? "Recovery email updated — send code to verify" : "Recovery email removed");
  } catch (ex) {
    toast(ex.message, false);
  }
});

// theme seg in panel
$("thDark").addEventListener("click", () => { setTheme("dark"); saveVault(); });
$("thLight").addEventListener("click", () => { setTheme("light"); saveVault(); });
$("avInitials").addEventListener("click", () => { vault.avatar = "initials"; renderProfile(); saveVault(); });
$("avLeaf").addEventListener("click", () => { vault.avatar = "leaf"; renderProfile(); saveVault(); });

// switches
function setSwitch(id, on) {
  const sw = $(id);
  sw.classList.toggle("on", !!on);
  sw.setAttribute("aria-checked", String(!!on));
}
["swNick", "swPrompt", "swVault", "swLog"].forEach((id) => {
  const el = $(id);
  const flip = () => {
    const on = !el.classList.contains("on");
    vault.privacy[id.slice(2).toLowerCase()] = on;
    setSwitch(id, on);
    saveVault();
  };
  el.addEventListener("click", flip);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
  });
});

// verification
$("verifySendBtn").addEventListener("click", async () => {
  try {
    await api("/api/verify/send", {});
    toast("Code sent to recovery email");
  } catch (ex) {
    toast(ex.message, false);
  }
});
$("verifyConfirmBtn").addEventListener("click", async () => {
  try {
    const out = await api("/api/verify/confirm", { code: $("verifyCode").value.trim() });
    user = out.user;
    renderProfile();
    toast("Recovery email verified ✓");
  } catch (ex) {
    toast(ex.message, false);
  }
});

// password change
$("pwChangeBtn").addEventListener("click", async () => {
  if (!$("pwCurrent").value || !$("pwNext").value) return toast("Fill in both password fields", false);
  try {
    await api("/api/password/change", { current: $("pwCurrent").value, next: $("pwNext").value });
    $("pwCurrent").value = $("pwNext").value = "";
    toast("Password changed — other sessions signed out");
  } catch (ex) {
    toast(ex.message, false);
  }
});

// ── 2FA ──────────────────────────────────────────────────────────────────────
$("twoFASetupBtn").addEventListener("click", async () => {
  try {
    const out = await api("/api/2fa/setup", {});
    $("twoFAOffUI").hidden = true;
    $("twoFASetupUI").hidden = false;
    $("totpSecret").textContent = out.secret;
    $("qrBox").innerHTML = `<img src="${out.qr}" alt="TOTP QR code" width="180" height="180" loading="lazy">`;
    $("totpConfirm").focus();
  } catch (ex) {
    toast(ex.message, false);
  }
});

$("twoFAConfirmBtn").addEventListener("click", async () => {
  try {
    const out = await api("/api/2fa/confirm", { code: $("totpConfirm").value.trim() });
    recoveryCodes = out.recovery_codes || [];
    user.totp_enabled = true;
    renderProfile();
    renderCodes();
    $("twoFASetupUI").hidden = true;
    $("codesBox").hidden = false;
    toast("2FA enabled — save your recovery codes");
  } catch (ex) {
    toast(ex.message, false);
  }
});

function renderCodes() {
  const grid = $("codeGrid");
  grid.innerHTML = "";
  recoveryCodes.forEach((c) => {
    const d = document.createElement("div");
    d.className = "code-chip";
    d.textContent = c;
    grid.appendChild(d);
  });
}

$("showCodesBtn").addEventListener("click", () => {
  $("codesBox").hidden = !$("codesBox").hidden;
  if (!$("codesBox").hidden && !recoveryCodes.length) {
    toast("Recovery codes were shown once at setup", false);
  }
});

$("copyCodesBtn").addEventListener("click", () => {
  if (!recoveryCodes.length) return;
  navigator.clipboard.writeText(recoveryCodes.join("\n")).then(() => toast("Codes copied"));
});

$("twoFADisableBtn").addEventListener("click", () => {
  $("twoFADisableUI").hidden = !$("twoFADisableUI").hidden;
});

$("twoFADisableConfirm").addEventListener("click", async () => {
  try {
    await api("/api/2fa/disable", { password: $("twoFAPw").value });
    user.totp_enabled = false;
    recoveryCodes = [];
    renderProfile();
    toast("2FA disabled");
  } catch (ex) {
    toast(ex.message, false);
  }
});

// ── sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const out = await api("/api/sessions", null, "GET");
    const box = $("sessionsList");
    box.innerHTML = "";
    if (!out.sessions.length) {
      box.innerHTML = '<p class="empty">No active sessions</p>';
      return;
    }
    out.sessions.forEach((s) => {
      const row = document.createElement("div");
      row.className = "sess";
      row.innerHTML = `
        <span class="ms">devices</span>
        <div class="sess-body">
          <div class="sess-label">${esc(s.label || "Session")} ${s.current ? '<span class="sess-current">· this device</span>' : ""}</div>
          <div class="sess-meta">${esc(s.ip_prefix || "")} · last active ${timeAgo(s.last_used)}</div>
        </div>
        ${s.current ? "" : '<button class="mini-btn danger">Revoke</button>'}`;
      if (!s.current) {
        row.querySelector("button").addEventListener("click", async () => {
          try {
            await api("/api/sessions/revoke", { id: s.id });
            loadSessions();
            toast("Session revoked");
          } catch (ex) {
            toast(ex.message, false);
          }
        });
      }
      box.appendChild(row);
    });
  } catch {}
}

$("revokeAllBtn").addEventListener("click", async () => {
  try {
    await api("/api/sessions/revoke-all", {});
    loadSessions();
    toast("All other sessions signed out");
  } catch (ex) {
    toast(ex.message, false);
  }
});

// ── events ───────────────────────────────────────────────────────────────────
async function loadEvents() {
  try {
    const out = await api("/api/events", null, "GET");
    const box = $("eventsList");
    box.innerHTML = "";
    if (!out.events.length) {
      box.innerHTML = '<p class="empty">No events yet</p>';
      return;
    }
    out.events.forEach((ev) => {
      const row = document.createElement("div");
      row.className = "sess";
      row.innerHTML = `
        <span class="ms">${eventIcon(ev.kind)}</span>
        <div class="sess-body">
          <div class="sess-label">${eventLabel(ev.kind)}</div>
          <div class="sess-meta">${esc(ev.ip_prefix || "")} · ${timeAgo(ev.at)}</div>
        </div>`;
      box.appendChild(row);
    });
  } catch {}
}

function eventIcon(kind) {
  return { login: "login", login_fail: "gpp_bad", logout: "logout", register: "person_add",
    totp_on: "add_moderator", totp_off: "remove_moderator", pass_change: "lock_reset",
    recovery_used: "vpn_key" }[kind] || "info";
}

function eventLabel(kind) {
  return { login: "Signed in", login_fail: "Failed sign-in", logout: "Signed out", register: "Account created",
    totp_on: "2FA enabled", totp_off: "2FA disabled", pass_change: "Password changed",
    recovery_used: "Recovery code used" }[kind] || kind;
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

// ── delete ───────────────────────────────────────────────────────────────────
$("deleteBtn").addEventListener("click", () => {
  $("deleteUI").hidden = !$("deleteUI").hidden;
});
$("deleteConfirmBtn").addEventListener("click", async () => {
  try {
    await api("/api/account/delete", { password: $("deletePw").value });
    toast("Account deleted");
    setTimeout(() => location.reload(), 900);
  } catch (ex) {
    toast(ex.message, false);
  }
});

// ── connected services (Quick Sign-In via Inpriv ID) ────────────────────────
// The list comes from the backend (/api/services): every service that redeems
// Quick Sign-In grants, with this account's consent state. Unconnected
// services still show up (with a "Connect" link) so users can discover them.
async function loadServices() {
  const box = $("servicesList");
  if (!box) return;
  box.innerHTML = '<p class="empty">Loading…</p>';
  let services = null;
  try {
    const out = await api("/api/services", null, "GET");
    services = out.services || [];
  } catch {
    services = null;
  }
  if (!services) {
    box.innerHTML = '<p class="empty">Could not load services</p>';
    return;
  }
  box.innerHTML = "";
  if (!services.length) {
    box.innerHTML = '<p class="empty">No services support Quick Sign-In yet</p>';
    return;
  }
  services
    .slice()
    .sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name))
    .forEach((s) => {
      const row = document.createElement("div");
      row.className = "row";
      const badge = s.connected
        ? `<span class="sess-meta" style="margin-left:2px">Quick Sign-In · last used ${timeAgo(s.last_used)}</span>`
        : "";
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px">
          <span class="ms" style="color:var(--md-primary)">${s.icon}</span>
          <div>
            <div class="row-label">${esc(s.name)}</div>
            ${badge}
          </div>
        </div>
        <a class="mini-btn" href="${esc(s.url)}" target="_blank" rel="noopener">${s.connected ? "Open" : "Connect"}</a>`;
      box.appendChild(row);
    });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("login") === "1" || params.get("signin") === "1") {
    switchAuth("login");
  } else {
    switchAuth("register");
  }
  if (!token) {
    show("auth");
    return;
  }
  try {
    await enterPanel();
  } catch {
    show("auth");
  }
})();
