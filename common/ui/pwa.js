/* Installed-app startup: paint before the UI core loads, then stay in sync. */
(function () {
  'use strict';
  var root = document.documentElement;
  var system = window.matchMedia('(prefers-color-scheme: light)');
  var standalone = window.matchMedia('(display-mode: standalone)');
  try {
    var saved = localStorage.getItem('inpriv_theme') || localStorage.getItem('inpriv-theme');
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch (e) {}
  function paint() {
    var theme = root.dataset.theme || (system.matches ? 'light' : 'dark');
    var color = theme === 'light' ? '#ebe9e4' : '#0c0c0b';
    root.style.backgroundColor = color;
    root.style.colorScheme = theme;
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.content = color;
    });
    // In an app window, the brand is this app's home, not another origin.
    var brand = document.querySelector('.top .brand');
    if (brand && (standalone.matches || navigator.standalone === true)) {
      brand.href = '/';
      var name = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      brand.setAttribute('aria-label', (name ? name.content : 'Inpriv') + ' home');
    }
  }
  paint();
  window.addEventListener('inpriv:theme', paint);
  window.addEventListener('pageshow', paint);
  if (system.addEventListener) system.addEventListener('change', paint);
  var deferred = null, installed = false, installing = false;
  function state() {
    return { installed: installed || standalone.matches || navigator.standalone === true, installing: installing, canPrompt: !!deferred };
  }
  function changed() {
    window.dispatchEvent(new CustomEvent('inpriv:pwa', { detail: state() }));
  }
  window.addEventListener('beforeinstallprompt', function (event) {
    if (!root.hasAttribute('data-install-ui')) return;
    event.preventDefault();
    deferred = event; installing = false; changed();
  });
  window.addEventListener('appinstalled', function () {
    installed = true; installing = false; deferred = null; changed();
  });
  if (standalone.addEventListener) standalone.addEventListener('change', changed);
  window.InprivPWA = {
    state: state,
    install: async function () {
      if (state().installed) return 'installed';
      if (installing) return 'pending';
      if (!deferred) return 'unavailable';
      var event = deferred;
      deferred = null; installing = true; changed();
      try {
        // Invoke the prompt before awaiting anything, while the tap is active.
        var choice = await event.prompt();
        if (!choice || !choice.outcome) choice = await event.userChoice;
        installing = !!(choice && choice.outcome === 'accepted' && !installed);
        changed();
        return choice && choice.outcome || 'dismissed';
      } catch (e) { installing = false; changed(); return 'unavailable'; }
    }
  };
  window.addEventListener('load', function () {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function () {});
    }
  });
})();
