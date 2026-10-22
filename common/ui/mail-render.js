/* Inpriv mail renderer — turns untrusted email HTML into a srcdoc page that
   loads nothing from the sender. Source of truth for the copies inlined
   into .mail/index.html and .temp/index.html as <script id="inpriv-mail-render">
   (tests/check-inline.mjs checks that they match).

   Layers, each enough on its own to block a tracking pixel:
   1. An allowlist sanitizer on an inert DOMParser document: unknown or
      active elements and attributes are removed, links are limited to
      http(s) and mailto, remote image sources are dropped unless the person
      asked to load images, and CSS is re-serialized through the CSSOM with
      every url() removed (no regular expressions decide what is HTML).
   2. A Content-Security-Policy inside the frame: default-src 'none', images
      only from data: (plus https: after "Load images").
   3. The page puts it in a sandboxed iframe without allow-scripts, so
      nothing in a message can run. allow-same-origin stays so the page can
      measure the message and size the frame; with scripts off, that gives
      the message nothing to act with. */
(function () {
  'use strict';
  if (window.InprivMailRender) return;

  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var KEEP = set('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr');
  // removed with everything inside them
  var DROP = set('script style noscript template iframe frame frameset object embed applet noembed noframes input button select textarea option optgroup datalist output svg math audio video source track canvas map area portal link meta base title head dialog slot xmp plaintext');
  var GLOBAL_ATTRS = set('class dir lang title align valign width height bgcolor color border style role');
  var TAG_ATTRS = {
    a: set('href'), img: set('src alt'), td: set('colspan rowspan nowrap scope abbr headers'),
    th: set('colspan rowspan nowrap scope abbr headers'), table: set('cellpadding cellspacing summary'),
    col: set('span'), colgroup: set('span'), font: set('face size'), ol: set('start type reversed'),
    ul: set('type'), li: set('value type'), time: set('datetime'), hr: set('noshade size')
  };
  var IMG_PROPS = set('background background-image list-style list-style-image border-image border-image-source');
  var DATA_IMG = /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+\/=\s]+$/i;

  function set(s) { var o = Object.create(null); s.split(' ').forEach(function (k) { o[k] = 1; }); return o; }

  function safeHref(v) {
    v = String(v || '').trim();
    if (v.length > 2048) return null;
    return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
  }

  // Every url() in a CSS value: allowed only for image properties, and only
  // https: (after "Load images") or an inline data: image.
  function cssValueOk(name, value, remote, st) {
    var v = String(value || '');
    if (/expression\s*\(|javascript:|-moz-binding|behavior/i.test(v)) return false;
    if (!/url\s*\(|image-set|image\s*\(|element\s*\(|cross-fade|paint\s*\(/i.test(v)) return true;
    if (!IMG_PROPS[name] || /image-set|image\s*\(|element\s*\(|cross-fade|paint\s*\(/i.test(v)) { st.blocked++; return false; }
    var re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi, m, ok = true;
    while ((m = re.exec(v))) {
      var u = m[2].trim();
      if (DATA_IMG.test(u)) continue;
      if (remote && /^https:\/\//i.test(u)) continue;
      ok = false;
    }
    if (!ok) st.blocked++;
    return ok;
  }

  function cleanDecls(style, remote, st) {
    for (var i = style.length - 1; i >= 0; i--) {
      var name = style[i];
      if (!cssValueOk(name, style.getPropertyValue(name), remote, st)) style.removeProperty(name);
    }
    var pos = style.getPropertyValue('position');
    if (pos === 'fixed' || pos === 'sticky') style.removeProperty('position');
  }

  // <style> blocks: parsed into a constructed stylesheet (which ignores
  // @import), rebuilt from style, @media and @supports rules only.
  function cleanCss(text, remote, st) {
    if (!text || typeof CSSStyleSheet !== 'function') return '';
    var sheet;
    try { sheet = new CSSStyleSheet(); sheet.replaceSync(text); } catch (e) { return ''; }
    function rules(list) {
      var out = '';
      for (var i = 0; i < list.length; i++) {
        var r = list[i], t = '';
        if (r.type === 1) {
          cleanDecls(r.style, remote, st);
          t = r.selectorText + '{' + r.style.cssText + '}';
        } else if (r.type === 4) {
          t = '@media ' + r.media.mediaText + '{' + rules(r.cssRules) + '}';
        } else if (r.type === 12) {
          t = '@supports ' + r.conditionText + '{' + rules(r.cssRules) + '}';
        }
        // last check on the serialized rule: nothing that loads may remain
        if (t && !/@import/i.test(t) && !/url\(\s*['"]?\s*(?!https:|data:image\/)/i.test(t) &&
            (remote || !/url\(\s*['"]?\s*https:/i.test(t))) out += t + '\n';
      }
      return out;
    }
    return rules(sheet.cssRules).replace(/</g, '\\3c ');
  }

  function cleanAttrs(el, tag, remote, st) {
    var allowed = TAG_ATTRS[tag];
    Array.prototype.slice.call(el.attributes).forEach(function (a) {
      var n = a.name.toLowerCase();
      if (n === 'background' && /^\s*https?:/i.test(a.value)) st.blocked++;
      if (!(GLOBAL_ATTRS[n] || (allowed && allowed[n]) || /^aria-[a-z-]+$/.test(n))) el.removeAttribute(a.name);
    });
    if (el.hasAttribute('style')) {
      cleanDecls(el.style, remote, st);
      if (!el.style.length) el.removeAttribute('style');
    }
    if (tag === 'a') {
      var href = safeHref(el.getAttribute('href'));
      if (href) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
        el.setAttribute('referrerpolicy', 'no-referrer');
        el.setAttribute('title', href); // the real destination, whatever the text says
        st.links++;
      } else {
        el.removeAttribute('href');
      }
    } else if (tag === 'img') {
      var src = String(el.getAttribute('src') || '').trim();
      if (DATA_IMG.test(src) && src.length < 2e6) return;
      el.removeAttribute('src');
      if (/^https?:\/\//i.test(src) || /^\/\//.test(src)) {
        if (remote && /^https:\/\//i.test(src)) { el.setAttribute('src', src); return; }
        st.blocked++;
      }
      el.setAttribute('data-blocked', '');
    }
  }

  function walk(node, remote, st) {
    Array.prototype.slice.call(node.childNodes).forEach(function (k) {
      if (k.nodeType === 8 || k.nodeType === 7) { k.remove(); return; }
      if (k.nodeType !== 1) return;
      var tag = k.localName;
      if (k.namespaceURI !== HTML_NS || DROP[tag]) { k.remove(); return; }
      walk(k, remote, st);
      if (!KEEP[tag]) {
        while (k.firstChild) k.parentNode.insertBefore(k.firstChild, k);
        k.remove();
        return;
      }
      cleanAttrs(k, tag, remote, st);
    });
  }

  var PAPER =
    'html{background:#fff;-webkit-text-size-adjust:100%;text-size-adjust:100%}' +
    'body{margin:0;padding:24px 26px;background:#fff;color:#1d1d1b;' +
    'font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;overflow-wrap:break-word}' +
    'img{max-width:100%;height:auto}a{color:#1f5fbf}pre{white-space:pre-wrap}' +
    'blockquote{margin:0 0 0 .4em;padding-left:.9em;border-left:3px solid #e2e0da;color:#55534d}' +
    'hr{border:0;border-top:1px solid #e8e6e1}' +
    'img[data-blocked]{display:inline-block;min-width:16px;min-height:16px;background:#f2f0eb;box-shadow:inset 0 0 0 1px #dcd9d2;color:#8a877f;font-size:12px}' +
    '@media (max-width:600px){body{padding:16px}}';

  // html → { doc: srcdoc text, blocked: remote resources removed, links }
  function build(html, opts) {
    var remote = !!(opts && opts.remote);
    var st = { blocked: 0, links: 0 };
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var css = Array.prototype.map.call(doc.querySelectorAll('style'), function (s) { return s.textContent; }).join('\n');
    var body = doc.body || doc.createElement('body');
    var wrap = doc.createElement('div');
    wrap.className = 'inpriv-mail';
    var bg = body.getAttribute('bgcolor'), fg = body.getAttribute('text');
    if (body.getAttribute('style')) wrap.setAttribute('style', body.getAttribute('style'));
    if (bg && /^#?[a-z0-9]{3,8}$/i.test(bg)) wrap.style.backgroundColor = bg;
    if (fg && /^#?[a-z0-9]{3,8}$/i.test(fg)) wrap.style.color = fg;
    while (body.firstChild) wrap.appendChild(body.firstChild);
    walk(wrap, remote, st);
    if (wrap.hasAttribute('style')) { cleanDecls(wrap.style, remote, st); }
    var cleanStyle = cleanCss(css, remote, st);
    var csp = "default-src 'none'; img-src data:" + (remote ? ' https:' : '') +
      "; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    return {
      blocked: st.blocked,
      links: st.links,
      doc: '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
        '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">' +
        '<meta name="color-scheme" content="light"><base target="_blank">' +
        '<style>' + PAPER + '</style>' + (cleanStyle ? '<style>' + cleanStyle + '</style>' : '') +
        '</head><body>' + wrap.outerHTML + '</body></html>'
    };
  }

  window.InprivMailRender = { build: build };
})();
