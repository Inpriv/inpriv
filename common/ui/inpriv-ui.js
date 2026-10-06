/* Inpriv UI core — icon sprite, theme, backdrop codes, pointer sheen,
   liquid pill, app switcher, toast. Source of truth for every page:
   `node common/ui/sync.mjs` copies it into <script id="inpriv-ui-js">.
   No network access, no storage beyond the theme choice. */
(function () {
  'use strict';
  if (window.InprivUI) return;

  var doc = document;
  var root = doc.documentElement;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── icons ──────────────────────────────────────────────────────────────
  // 24-unit grid, drawn at 18px, stroke 1.8 (see .i in inpriv-ui.css)
  var P = {
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7.5 8 6 8-6"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    outbox: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    'user-plus': '<circle cx="10" cy="8" r="4"/><path d="M3 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m2 2 20 20"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    'shield-plus': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8.5v6M9 11.5h6"/>',
    'shield-x': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8"/><path d="m16 7 3 3"/><path d="m19 4 2 2"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    'arrow-left': '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    external: '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
    reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>',
    rich: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
    plain: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    hourglass: '<path d="M6 2h12M6 22h12"/><path d="M7 2v3a5 5 0 0 0 10 0V2"/><path d="M7 22v-3a5 5 0 0 1 10 0v3"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" stroke-width="2.6"/>',
    clip: '<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15 6.6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    id: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2"/><path d="M6 16a3 3 0 0 1 6 0"/><path d="M15 10h3M15 14h3"/>',
    dots: '<rect x="2" y="6" width="20" height="12" rx="3"/><path d="M7 12h.01M12 12h.01M17 12h.01" stroke-width="2.6"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    github: '<path fill="currentColor" stroke="none" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'
  };
  // Material Symbols names still used by page scripts → sprite ids
  var ALIAS = {
    mail_lock: 'mail', mark_email_unread: 'mail', alternate_email: 'at', outgoing_mail: 'send',
    account_circle: 'user', person_add: 'user-plus', lock_open: 'unlock', visibility: 'eye',
    visibility_off: 'eye-off', verified_user: 'shield-check', shield_locked: 'shield',
    add_moderator: 'shield-plus', remove_moderator: 'shield-x', gpp_bad: 'shield-x',
    vpn_key: 'key', lock_reset: 'key', password: 'dots', arrow_forward: 'arrow-right',
    arrow_back: 'arrow-left', arrow_outward: 'arrow-up-right', open_in_new: 'external',
    content_copy: 'copy', delete: 'trash', delete_forever: 'trash', public: 'globe',
    palette: 'rich', subject: 'plain', memory: 'cpu', check_circle: 'check', error: 'alert',
    schedule: 'clock', casino: 'dice', attach_file: 'clip', block: 'ban', light_mode: 'sun',
    dark_mode: 'moon', devices: 'monitor', bolt: 'zap', hub: 'link', badge: 'id',
    visibility_lock: 'lock', person: 'user'
  };
  function iconId(name) { name = ALIAS[name] || name; return P[name] ? name : 'info'; }
  function icon(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + iconId(name) + '"/></svg>';
  }
  var LOGO = '<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4 18 11.4H6Z"/><path d="M6 12.6h12L12 21.6Z"/></svg>';

  function injectSprite() {
    if (doc.getElementById('inpriv-sprite')) return;
    var s = '<svg id="inpriv-sprite" xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">';
    for (var k in P) s += '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + P[k] + '</symbol>';
    doc.body.insertAdjacentHTML('afterbegin', s + '</svg>');
  }
  // static markup can use <i data-icon="name"></i> placeholders
  function hydrateIcons(scope) {
    (scope || doc).querySelectorAll('i[data-icon]').forEach(function (el) {
      el.outerHTML = icon(el.getAttribute('data-icon'), el.className);
    });
    (scope || doc).querySelectorAll('[data-logo]').forEach(function (el) {
      el.innerHTML = LOGO; el.removeAttribute('data-logo');
    });
  }

  // ── theme (system by default; the toggle stores an explicit choice) ────
  var THEME_KEY = 'inpriv_theme';
  var mqLight = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
  function effectiveTheme() {
    return root.dataset.theme || (mqLight && mqLight.matches ? 'light' : 'dark');
  }
  function syncTheme() {
    var eff = effectiveTheme();
    doc.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.innerHTML = icon(eff === 'dark' ? 'sun' : 'moon');
      b.setAttribute('aria-label', eff === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      b.title = b.getAttribute('aria-label');
    });
    doc.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      if (root.dataset.theme) m.setAttribute('content', eff === 'dark' ? '#0c0c0b' : '#ebe9e4');
      else m.setAttribute('content', m.media && m.media.indexOf('light') > -1 ? '#ebe9e4' : '#0c0c0b');
    });
  }
  function setTheme(t) {
    if (t === 'light' || t === 'dark') {
      root.dataset.theme = t;
      try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    } else {
      delete root.dataset.theme;
      try { localStorage.removeItem(THEME_KEY); } catch (e) {}
    }
    syncTheme();
    window.dispatchEvent(new CustomEvent('inpriv:theme', { detail: effectiveTheme() }));
  }
  function toggleTheme() { setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); }
  if (mqLight && mqLight.addEventListener) mqLight.addEventListener('change', syncTheme);

  // ── backdrop: two rows of huge, faint, drifting codes ─────────────────
  function fillTicker() {
    var abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    doc.querySelectorAll('.ticker .track').forEach(function (track) {
      var codes = [];
      for (var i = 0; i < 6; i++) {
        var c = '';
        for (var j = 0; j < 4; j++) c += abc[Math.floor(Math.random() * abc.length)];
        codes.push(c);
      }
      var run = codes.join(' ');
      track.innerHTML = '<span>' + run + '</span><span>' + run + '</span>';
    });
  }

  // ── pointer sheen on glass (mouse only, one update per frame) ──────────
  function bindSheen() {
    if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var px = 0, py = 0, pending = false;
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      px = e.clientX; py = e.clientY;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        doc.querySelectorAll('.glass').forEach(function (g) {
          var r = g.getBoundingClientRect();
          var near = px > r.left - 60 && px < r.right + 60 && py > r.top - 60 && py < r.bottom + 60;
          if (near) {
            g.style.setProperty('--mx', (px - r.left) + 'px');
            g.style.setProperty('--my', (py - r.top) + 'px');
          }
          if ((g.style.getPropertyValue('--sheen') === '1') !== near) g.style.setProperty('--sheen', near ? '1' : '0');
        });
      });
    }, { passive: true });
  }

  // ── liquid pill ────────────────────────────────────────────────────────
  // Turns any segmented control into one with a spring-driven thumb. Pages
  // keep their own selection logic (classes .on/.active, aria-selected or
  // aria-current); the thumb follows whatever is selected. The thumb can be
  // pressed and dragged; release picks the nearest option via a click.
  var STEP = 1 / 240;
  function isOn(el) {
    return el.classList.contains('on') || el.classList.contains('active') ||
      el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'page';
  }
  function enhance(seg) {
    if (seg._liquid) return;
    seg._liquid = true;
    seg.classList.add('liquid');
    var thumb = doc.createElement('span');
    thumb.className = 'liquid-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    seg.insertBefore(thumb, seg.firstChild);

    var x = 0, w = 0, y = 0, h = 0, vx = 0, vw = 0, tx = 0, tw = 0;
    var s = 1, vs = 0, ts = 1;
    var placed = false, raf = 0, last = 0, drag = null, swallowUntil = 0;

    function options() {
      var out = [];
      for (var i = 0; i < seg.children.length; i++) {
        var el = seg.children[i];
        if (el !== thumb && el.offsetWidth > 0 && el.matches('button, a, [role="tab"], [role="radio"]')) out.push(el);
      }
      return out;
    }
    function current() {
      var o = options();
      for (var i = 0; i < o.length; i++) if (isOn(o[i])) return o[i];
      return null;
    }
    function render() {
      var stretch = Math.min(0.16, Math.abs(vx) / 6000);
      thumb.style.width = w + 'px';
      thumb.style.height = h + 'px';
      thumb.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + (s * (1 + stretch)) + ',' + (s * (1 - stretch / 2)) + ')';
    }
    function settle(snap) {
      var el = current();
      if (!el) { thumb.style.opacity = '0'; placed = false; return; }
      thumb.style.opacity = '1';
      tx = el.offsetLeft; tw = el.offsetWidth; y = el.offsetTop; h = el.offsetHeight;
      if (snap || !placed || reduced) { x = tx; w = tw; vx = vw = 0; placed = true; render(); return; }
      kick();
    }
    function step(now) {
      var dt = Math.min(0.05, (now - last) / 1000 || 1 / 60);
      last = now;
      while (dt > 0) {
        var d = Math.min(dt, STEP);
        dt -= d;
        if (!drag || !drag.active) { vx += (520 * (tx - x) - 28 * vx) * d; x += vx * d; }
        vw += (520 * (tw - w) - 28 * vw) * d; w += vw * d;
        vs += (700 * (ts - s) - 22 * vs) * d; s += vs * d;
      }
      render();
      var still = !(drag && drag.active) &&
        Math.abs(tx - x) < 0.3 && Math.abs(vx) < 2 && Math.abs(tw - w) < 0.3 && Math.abs(vw) < 2 &&
        Math.abs(ts - s) < 0.002 && Math.abs(vs) < 0.02;
      if (still) { x = tx; w = tw; s = ts; vx = vw = vs = 0; render(); raf = 0; return; }
      raf = requestAnimationFrame(step);
    }
    function kick() {
      if (reduced) { x = tx; w = tw; s = ts; render(); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
    }

    seg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || !placed) return;
      var r = seg.getBoundingClientRect();
      var lx = e.clientX - r.left;
      if (lx < x || lx > x + w) return;           // only the thumb itself drags
      drag = { id: e.pointerId, sx: e.clientX, x0: x, lx: e.clientX, lt: performance.now(), active: false };
      ts = 1.1; kick();
    });
    seg.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.sx;
      if (!drag.active) {
        if (Math.abs(dx) < 4) return;
        drag.active = true;
        seg.classList.add('dragging');
        try { seg.setPointerCapture(e.pointerId); } catch (err) {}
      }
      var o = options();
      if (!o.length) return;
      var min = o[0].offsetLeft, max = o[o.length - 1].offsetLeft + o[o.length - 1].offsetWidth - w;
      var raw = drag.x0 + dx, limit = Math.min(14, w * 0.2), nx = raw;
      if (raw < min) nx = min - limit * (1 - Math.exp(-(min - raw) / 40));
      else if (raw > max) nx = max + limit * (1 - Math.exp(-(raw - max) / 40));
      var now = performance.now();
      vx = (e.clientX - drag.lx) / Math.max(1, now - drag.lt) * 1000;
      drag.lx = e.clientX; drag.lt = now;
      x = nx;
      // width follows the option underneath
      var mid = x + w / 2, best = o[0], bd = Infinity;
      o.forEach(function (el) { var c = el.offsetLeft + el.offsetWidth / 2, dd = Math.abs(c - mid); if (dd < bd) { bd = dd; best = el; } });
      tw = best.offsetWidth;
      kick();
    });
    function release(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var wasActive = drag.active;
      drag = null;
      ts = 1;
      seg.classList.remove('dragging');
      if (wasActive) {
        swallowUntil = performance.now() + 80;
        var o = options(), mid = x + w / 2 + vx * 0.08, best = null, bd = Infinity;
        o.forEach(function (el) { var c = el.offsetLeft + el.offsetWidth / 2, dd = Math.abs(c - mid); if (dd < bd) { bd = dd; best = el; } });
        if (best && !isOn(best)) best.click();
        else settle(false);
      }
      kick();
    }
    seg.addEventListener('pointerup', release);
    seg.addEventListener('pointercancel', release);
    seg.addEventListener('click', function (e) {
      if (e.isTrusted && performance.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // keyboard: arrows move between options
    seg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var o = options(), i = o.indexOf(current());
      if (i < 0) return;
      var n = o[Math.max(0, Math.min(o.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
      if (n && n !== o[i]) { e.preventDefault(); n.focus(); n.click(); }
    });

    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) if (recs[i].target !== thumb) { settle(false); return; }
    }).observe(seg, { attributes: true, subtree: true, childList: true, attributeFilter: ['class', 'aria-selected', 'aria-current', 'hidden'] });
    if (window.ResizeObserver) new ResizeObserver(function () { settle(true); }).observe(seg);
    settle(true);
  }
  var liquidSelectors = [];
  function liquid(selector) {
    liquidSelectors.push(selector);
    doc.querySelectorAll(selector).forEach(enhance);
  }
  function watchLiquid() {
    new MutationObserver(function (recs) {
      if (!liquidSelectors.length) return;
      var sel = liquidSelectors.join(',');
      recs.forEach(function (r) {
        r.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches(sel)) enhance(n);
          n.querySelectorAll(sel).forEach(enhance);
        });
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  // ── app switcher: the pill moves first, then the page changes ──────────
  function bindSwitcher() {
    doc.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.switcher a');
      if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
      e.preventDefault();
      if (a.getAttribute('aria-current') === 'page') return;
      var nav = a.parentNode;
      nav.querySelectorAll('a').forEach(function (x) {
        if (x.getAttribute('aria-current') === 'page') x.setAttribute('data-was-current', '');
        x.removeAttribute('aria-current');
      });
      a.setAttribute('aria-current', 'page');
      setTimeout(function () { location.href = a.href; }, reduced ? 0 : 200);
    });
    // coming back through the back/forward cache: restore the real page
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      doc.querySelectorAll('.switcher').forEach(function (nav) {
        var was = nav.querySelector('[data-was-current]');
        if (!was) return;
        nav.querySelectorAll('a').forEach(function (x) { x.removeAttribute('aria-current'); });
        was.setAttribute('aria-current', 'page');
        was.removeAttribute('data-was-current');
      });
    });
  }

  // ── toast: one glass pill at the bottom ────────────────────────────────
  function toast(title, opts) {
    opts = opts || {};
    var host = doc.getElementById('toaster');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'toaster';
      host.className = 'toaster';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      doc.body.appendChild(host);
    }
    var el = doc.createElement('div');
    el.className = 'toast glass' + (opts.error ? ' error' : '');
    var text = doc.createElement('div');
    text.className = 'toast-text';
    var t = doc.createElement('div');
    t.className = 'toast-title';
    t.textContent = title;
    text.appendChild(t);
    if (opts.desc) {
      var d = doc.createElement('div');
      d.className = 'toast-desc';
      d.textContent = opts.desc;
      text.appendChild(d);
    }
    el.innerHTML = icon(opts.icon || (opts.error ? 'alert' : 'check'));
    el.appendChild(text);
    while (host.children.length > 2) host.removeChild(host.firstChild);
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 280);
    }, opts.error ? 4500 : 2200 + (opts.desc ? 1200 : 0));
    return el;
  }

  window.InprivUI = {
    icon: icon, logo: LOGO, toast: toast, liquid: liquid, enhance: enhance,
    setTheme: setTheme, toggleTheme: toggleTheme, theme: effectiveTheme, syncTheme: syncTheme, hydrate: hydrateIcons
  };

  function boot() {
    injectSprite();
    hydrateIcons(doc);
    fillTicker();
    syncTheme();
    bindSheen();
    watchLiquid();
    liquid('.switcher');
    bindSwitcher();
    doc.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-theme-toggle]')) toggleTheme();
    });
    // Escape closes the topmost dialog (pages close theirs on a scrim click)
    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = doc.querySelectorAll('.modal-overlay.open, .modal-backdrop.open');
      if (open.length) open[open.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
