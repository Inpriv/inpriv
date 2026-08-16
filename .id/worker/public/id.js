// Inpriv ID — One Tap widget.
// Drop-in: <script src="https://id.inpriv.xyz/id.js" data-service="mail" defer></script>
//
// Behavior (Google-style):
//  - Signed in (session cookie readable cross-site): shows an avatar chip in
//    the top-right corner. Services that support accounts get a "Continue as
//    <nick>" prompt on first visit; the page receives window.InprivID.user +
//    an `inpriv:id` event for personalization (nick, theme).
//  - Signed out: no chip. On account-supporting services a small corner card
//    offers "Sign in / Create account" once per browser (dismiss = 7 days).
//  - Respects the user's privacy switch (prompt off → no prompts, chip only
//    on id.inpriv.xyz itself).
/* global document, window, localStorage, fetch */

(function () {
  "use strict";

  var ORIGIN = "https://id.inpriv.xyz";
  var script = document.currentScript;
  var service = (script && script.getAttribute("data-service")) || "";
  var supportsAccounts = !!(script && script.hasAttribute("data-accounts"));
  var DISMISS_KEY = "inpriv_id_dismiss_" + (service || "global");

  // never run inside iframes or on the account domain itself
  try {
    if (window.self !== window.top) return;
    if (location.hostname === "id.inpriv.xyz") return;
    if (!/\.inpriv\.xyz$/.test(location.hostname) && location.protocol !== "file:") return;
  } catch (e) { return; }

  var state = { user: null, checked: false };

  // ── session check (credentials included — cookie is Partitioned+SameSite=None) ──
  function check(cb) {
    fetch(ORIGIN + "/api/public/me", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { user: null }; })
      .then(function (d) { state.user = d.user || null; state.checked = true; cb && cb(state.user); })
      .catch(function () { state.checked = true; cb && cb(null); });
  }

  // ── styles ──────────────────────────────────────────────────────────────
  var CSS = [
    ".inpriv-id-chip{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;",
    "height:40px;padding:0 14px 0 6px;border-radius:9999px;cursor:pointer;border:1px solid rgba(128,134,115,.5);",
    "background:color-mix(in srgb,#1F211B 88%,transparent);color:#E3E2D3;",
    "backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);",
    "font:600 13px 'Roboto Flex',system-ui,sans-serif;letter-spacing:.01em;",
    "box-shadow:0 4px 20px -4px rgba(0,0,0,.4);opacity:0;transform:translateY(-12px) scale(.95);",
    "transition:all .5s cubic-bezier(.2,1.4,0,1);text-decoration:none}",
    ".inpriv-id-chip.in{opacity:1;transform:translateY(0) scale(1)}",
    ".inpriv-id-chip:hover{transform:translateY(-2px);box-shadow:0 8px 26px -6px rgba(0,0,0,.5)}",
    ".inpriv-id-chip:active{transform:scale(.95)}",
    ".inpriv-id-av{width:30px;height:30px;border-radius:50%;background:#2E4F2F;color:#C7EFA0;",
    "display:grid;place-items:center;font:800 13px 'Roboto Flex',sans-serif;flex-shrink:0}",
    ".inpriv-id-chip .x{font-size:15px;line-height:1;opacity:.6;cursor:pointer;padding:4px;border-radius:50%}",
    ".inpriv-id-chip .x:hover{opacity:1}",
    ".inpriv-id-card{position:fixed;top:64px;right:14px;z-index:2147483000;width:300px;padding:20px;",
    "border-radius:24px;border:1px solid rgba(128,134,115,.5);",
    "background:color-mix(in srgb,#1F211B 92%,transparent);color:#E3E2D3;",
    "backdrop-filter:blur(28px) saturate(180%);-webkit-backdrop-filter:blur(28px) saturate(180%);",
    "box-shadow:0 16px 48px -8px rgba(0,0,0,.6);font-family:'Roboto Flex',system-ui,sans-serif;",
    "opacity:0;transform:translateY(-16px) scale(.96);pointer-events:none;",
    "transition:all .55s cubic-bezier(.2,1.4,0,1)}",
    ".inpriv-id-card.in{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}",
    ".inpriv-id-card h4{font-size:16px;font-weight:700;margin:0 0 4px}",
    ".inpriv-id-card p{font-size:12.5px;color:#C3C8B6;line-height:1.5;margin:0 0 14px}",
    ".inpriv-id-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:44px;",
    "border:none;border-radius:9999px;cursor:pointer;font:600 14px 'Roboto Flex',sans-serif;",
    "background:#ABD37A;color:#173800;transition:transform .2s cubic-bezier(.2,1.4,0,1)}",
    ".inpriv-id-btn:hover{transform:translateY(-2px)}",
    ".inpriv-id-btn:active{transform:scale(.96)}",
    ".inpriv-id-btn.ghost{background:transparent;color:#E3E2D3;border:1px solid rgba(128,134,115,.6);margin-top:8px}",
    ".inpriv-id-row{display:flex;gap:8px}",
    ".inpriv-id-prompt{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;align-items:center;gap:10px;",
    "height:48px;padding:0 8px 0 6px;border-radius:9999px;cursor:pointer;",
    "border:1px solid rgba(128,134,115,.5);background:color-mix(in srgb,#1F211B 88%,transparent);color:#E3E2D3;",
    "backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);",
    "font:600 13px 'Roboto Flex',system-ui,sans-serif;box-shadow:0 4px 20px -4px rgba(0,0,0,.4);",
    "opacity:0;transform:translateY(-12px) scale(.95);transition:all .5s cubic-bezier(.2,1.4,0,1)}",
    ".inpriv-id-prompt.in{opacity:1;transform:translateY(0) scale(1)}",
    "@media(prefers-reduced-motion:reduce){.inpriv-id-chip,.inpriv-id-card,.inpriv-id-prompt{transition:none}}",
  ].join("");

  function injectCss() {
    var st = document.createElement("style");
    st.id = "inpriv-id-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(n) {
    return String(n || "?").split(/[\s._-]+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w[0].toUpperCase(); }).join("") || "?";
  }
  function dismissed() {
    try { return Date.now() < parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10); } catch (e) { return false; }
  }
  function dismiss(days) {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + (days || 7) * 864e5)); } catch (e) {}
  }

  // ── signed-in: avatar chip + optional "Continue as" prompt ─────────────
  function renderSignedIn(u) {
    if (document.getElementById("inpriv-id-chip")) return;

    var chip = el("a", "inpriv-id-chip");
    chip.id = "inpriv-id-chip";
    chip.href = ORIGIN + "/";
    chip.target = "_blank";
    chip.rel = "noopener";
    chip.title = "Inpriv ID — " + u.nick;
    chip.innerHTML =
      '<span class="inpriv-id-av">' + esc(initials(u.nick)) + "</span>" +
      '<span style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(u.nick) + "</span>";
    document.body.appendChild(chip);
    requestAnimationFrame(function () { requestAnimationFrame(function () { chip.classList.add("in"); }); });

    // "Continue as <nick>" one-tap prompt on account-supporting services
    if (supportsAccounts && !dismissed() && !sessionConnected()) {
      setTimeout(function () {
        if (document.getElementById("inpriv-id-prompt")) return;
        var p = el("div", "inpriv-id-prompt");
        p.id = "inpriv-id-prompt";
        p.innerHTML =
          '<span class="inpriv-id-av" style="width:34px;height:34px">' + esc(initials(u.nick)) + "</span>" +
          "<div>Continue as <b>" + esc(u.nick) + "</b></div>" +
          '<span class="x" title="Not now">✕</span>';
        document.body.appendChild(p);
        requestAnimationFrame(function () { requestAnimationFrame(function () { p.classList.add("in"); }); });
        p.addEventListener("click", function (ev) {
          var x = ev.target.classList && ev.target.classList.contains("x");
          if (x) {
            dismiss(7);
            remove(p);
            return;
          }
          connect(function () {
            remove(p);
            window.dispatchEvent(new CustomEvent("inpriv:id", { detail: { user: u } }));
          });
        });
        // auto-hide after 25 s
        setTimeout(function () { remove(p); }, 25000);
      }, 1200);
    }
  }

  function sessionConnected() {
    try { return sessionStorage.getItem("inpriv_id_svc_" + service) === "1"; } catch (e) { return false; }
  }
  function connect(cb) {
    try { sessionStorage.setItem("inpriv_id_svc_" + service, "1"); } catch (e) {}
    window.dispatchEvent(new CustomEvent("inpriv:connect", { detail: { service: service, user: state.user } }));
    cb && cb();
  }

  function remove(node) {
    if (!node || !node.parentNode) return;
    node.classList.remove("in");
    setTimeout(function () { node.parentNode && node.parentNode.removeChild(node); }, 450);
  }

  // ── signed-out: corner card on account-supporting services ─────────────
  function renderSignedOut() {
    if (!supportsAccounts || dismissed()) return;
    if (document.getElementById("inpriv-id-card")) return;
    setTimeout(function () {
      var c = el("div", "inpriv-id-card");
      c.id = "inpriv-id-card";
      c.innerHTML =
        '<div style="width:44px;height:44px;border-radius:14px;background:#2E4F2F;color:#C7EFA0;display:grid;place-items:center;margin-bottom:12px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg></div>' +
        "<h4>One account, every Inpriv tool</h4>" +
        "<p>Sign in to sync your nickname and preferences across services. No tracking — your data stays encrypted.</p>" +
        '<div class="inpriv-id-row"><button class="inpriv-id-btn" data-a="signin">Sign in</button></div>' +
        '<button class="inpriv-id-btn ghost" data-a="register">Create account</button>' +
        '<div style="text-align:right;margin-top:10px"><span style="font-size:12px;color:#C3C8B6;cursor:pointer" data-a="close">Not now</span></div>';
      document.body.appendChild(c);
      requestAnimationFrame(function () { requestAnimationFrame(function () { c.classList.add("in"); }); });
      c.addEventListener("click", function (ev) {
        var a = ev.target.getAttribute && ev.target.getAttribute("data-a");
        if (a === "signin") location.href = ORIGIN + "/?login=1&next=" + encodeURIComponent(location.href);
        else if (a === "register") location.href = ORIGIN + "/?next=" + encodeURIComponent(location.href);
        else if (a === "close") { dismiss(7); remove(c); }
      });
      setTimeout(function () { remove(c); }, 30000);
    }, 2200);
  }

  // ── theme sync (vault) ─────────────────────────────────────────────────
  function applyPersonalization(u) {
    window.dispatchEvent(new CustomEvent("inpriv:id", { detail: { user: u } }));
    if (u && u.nick) {
      document.querySelectorAll("[data-inpriv-nick]").forEach(function (n) { n.textContent = u.nick; });
    }
  }

  // ── public API ─────────────────────────────────────────────────────────
  window.InprivID = {
    get user() { return state.user; },
    check: check,
    connect: connect,
    open: function () { location.href = ORIGIN + "/?next=" + encodeURIComponent(location.href); },
  };

  // ── boot ───────────────────────────────────────────────────────────────
  function start() {
    injectCss();
    check(function (u) {
      if (u) {
        renderSignedIn(u);
        applyPersonalization(u);
      } else {
        renderSignedOut();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
