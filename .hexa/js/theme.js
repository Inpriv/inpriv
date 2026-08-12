/* =====================================================================
   theme.js — light/dark theme manager
   Copyright (c) 2026 Aurex Labs — MIT License
   Default: dark (privacy-first). Honors saved preference, then system.
   ===================================================================== */
(function (global) {
  "use strict";

  const STORAGE_KEY = "inpriv-hexa-theme";
  const THEMES = ["dark", "light"];
  let mq;

  function resolveInitial() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch (_) {}
    // Default to dark regardless of system — privacy-first aesthetic.
    return "dark";
  }

  function apply(theme) {
    if (!THEMES.includes(theme)) theme = "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute("content", theme === "dark" ? "#13140e" : "#faf9f0");
      }
    } catch (_) {}
  }

  function current() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }

  function set(theme, persist) {
    apply(theme);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
    }
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: current() } }));
  }

  function toggle() {
    const next = current() === "dark" ? "light" : "dark";
    set(next, true);
  }

  // Follow the OS theme automatically (only if the user has not chosen).
  function bindSystem() {
    if (typeof global.matchMedia !== "function") return;
    mq = global.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => {
      let saved = null;
      try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
      if (saved !== "dark" && saved !== "light") {
        apply(e.matches ? "dark" : "light");
        document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: current() } }));
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else if (mq.addListener) mq.addListener(handler);
  }

  function init() {
    apply(resolveInitial());
    bindSystem();
    const btn = document.getElementById("themeToggle");
    if (btn) btn.addEventListener("click", toggle);
  }

  const Theme = { init, toggle, set, current, apply, THEMES };
  global.Theme = Theme;

  // Apply ASAP to avoid flash — run before app.js init.
  apply(resolveInitial());

  document.addEventListener("DOMContentLoaded", init);
})(window);
