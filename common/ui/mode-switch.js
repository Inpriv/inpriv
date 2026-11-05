/* Mail ⇄ Temp: a directional handoff across the two origins.
   The fragment carries only the source mode, never account or mailbox data. */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var pending = 0, recovery = 0, effects = [], observer;
  var from = /^#inpriv-switch=(mail|temp)$/.exec(location.hash);
  if (from) {
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!reduce.matches && root.animate) root.dataset.modeArrival = from[1];
  }

  function content() {
    var main = doc.getElementById('mainView');
    if (main) return main.children.length ? [main] : [];
    return Array.from(doc.querySelectorAll('.shell > :not(.top):not(#bannerSlot)'));
  }
  function reset() {
    clearTimeout(pending); clearTimeout(recovery);
    pending = recovery = 0;
    if (observer) observer.disconnect();
    effects.forEach(function (a) { a.cancel(); });
    effects = [];
    delete root.dataset.modeArrival;
    delete root.dataset.modeLeaving;
  }
  function motion(el, frames, options) {
    var a = el.animate(frames, options);
    effects.push(a);
    return a;
  }
  function arrive() {
    if (!root.dataset.modeArrival) return;
    var parts = content();
    if (!parts.length) return;
    if (observer) observer.disconnect();
    var direction = root.dataset.modeArrival === 'mail' ? 1 : -1;
    // These are one-shot entrances: don't restart them when the handoff ends.
    doc.querySelectorAll('.top .reveal').forEach(function (el) { el.style.animation = 'none'; });
    root.dataset.modeEntering = '';
    delete root.dataset.modeArrival;
    parts.forEach(function (el, i) {
      el.style.animation = 'none';
      el.querySelectorAll('.reveal, .auth-box, .card, .dash-toolbar, .msg-card, .empty-state').forEach(function (child) { child.style.animation = 'none'; });
      motion(el, [
        { opacity: 0, transform: 'translate3d(' + direction * 28 + 'px,8px,0) scale(.985)' },
        { opacity: 1, transform: 'translate3d(' + direction * -1.5 + 'px,0,0) scale(1)', offset: .8 },
        { opacity: 1, transform: 'none' }
      ], { duration: 460, delay: Math.min(i * 35, 105), easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
    });
    recovery = setTimeout(function () { delete root.dataset.modeEntering; effects = []; }, 650);
  }
  doc.addEventListener('DOMContentLoaded', function () {
    if (!root.dataset.modeArrival) return;
    observer = new MutationObserver(arrive);
    observer.observe(doc.body, { childList: true, subtree: true });
    arrive();
    // A delayed session/API must never keep the page invisible.
    setTimeout(function () { if (root.dataset.modeArrival) reset(); }, 1200);
  });

  // Registered in the head, before the shared switcher's click delegate.
  // Element-level drag suppression still runs first in the capture phase.
  doc.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-mode-switch] a[data-mode]');
    if (!a || e.defaultPrevented) return;
    if (e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.hasAttribute('download') || (a.target && a.target !== '_self')) {
      // Leave the native action intact without the older delegate taking over.
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    if (pending || root.hasAttribute('data-mode-leaving')) return;
    if (a.getAttribute('aria-current') === 'page') return;
    var nav = a.closest('[data-mode-switch]'), source = nav.dataset.modeSwitch;
    if (reduce.matches || !root.animate) { location.assign(a.href); return; }
    reset();
    delete root.dataset.modeEntering;
    var direction = a.dataset.mode === 'temp' ? 1 : -1;
    root.dataset.modeLeaving = '';
    nav.querySelectorAll('a').forEach(function (link) {
      if (link.getAttribute('aria-current') === 'page') link.setAttribute('data-was-current', '');
      link.removeAttribute('aria-current');
    });
    a.setAttribute('aria-current', 'page');
    motion(nav, [
      { transform: 'scale(1)' },
      { transform: 'scale(1.025,.97)', offset: .35 },
      { transform: 'scale(1)' }
    ], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    content().forEach(function (el) {
      motion(el, [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translate3d(' + direction * -20 + 'px,-3px,0) scale(.99)' }
      ], { duration: 180, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    });
    var destination = new URL(a.href);
    destination.hash = 'inpriv-switch=' + source;
    pending = setTimeout(function () {
      pending = 0;
      location.assign(destination.href);
      // Recover if navigation is cancelled or a beforeunload prompt stays.
      recovery = setTimeout(function () {
        reset();
        nav.querySelectorAll('a').forEach(function (link) {
          link.removeAttribute('aria-current');
          if (link.hasAttribute('data-was-current')) {
            link.setAttribute('aria-current', 'page');
            link.removeAttribute('data-was-current');
          }
        });
      }, 1600);
    }, 180);
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { reset(); delete root.dataset.modeEntering; } });
  reduce.addEventListener('change', function () {
    if (reduce.matches && !root.hasAttribute('data-mode-leaving')) { reset(); delete root.dataset.modeEntering; }
  });
})();
