/* Sender-provided unsubscribe actions. Discovery never makes a request.
   HTML discovery receives only the renderer's remote-blocked document. */
(function () {
  'use strict';

  function publicHost(host) {
    host = host.toLowerCase().replace(/\.$/, '');
    return host.includes('.') && !/^[\d.]+$/.test(host) &&
      /^[a-z0-9.-]+$/.test(host) && !/\.(localhost|local|internal|lan|home)$/.test(host);
  }

  function parse(raw) {
    if (typeof raw !== 'string' || raw.length > 4096) return null;
    raw = raw.trim();
    if (!raw || /[\u0000-\u0020\u007f-\u009f\\]/.test(raw)) return null;
    try {
      var url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        if (url.username || url.password || !publicHost(url.hostname)) return null;
        return { kind: 'web', href: url.href, host: url.hostname };
      }
      if (url.protocol !== 'mailto:' || url.hash) return null;
      var to = decodeURIComponent(url.pathname);
      if (to.length > 254 || /[\u0000-\u0020\u007f-\u009f]/.test(to) || !/^[^\s@,;<>?]+@[^\s@,;<>?]+$/.test(to) || !publicHost(to.split('@')[1])) return null;
      var subject = '', body = '', seen = new Set();
      for (var pair of url.searchParams) {
        var name = pair[0].toLowerCase();
        if ((name !== 'subject' && name !== 'body') || seen.has(name)) return null;
        seen.add(name);
        if (name === 'subject') subject = pair[1];
        else body = pair[1];
      }
      if (subject.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(subject)) return null;
      if (body.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(body)) return null;
      return { kind: 'email', to: to, subject: subject || 'Unsubscribe', body: body || 'Please unsubscribe me from this mailing list.' };
    } catch (e) { return null; }
  }

  function fromHeader(header) {
    if (typeof header !== 'string' || header.length > 8192) return null;
    var candidates = [], match, re = /<([^<>]+)>/g;
    while ((match = re.exec(header))) {
      var action = parse(match[1].replace(/[\r\n\t ]/g, ''));
      if (action) candidates.push(action);
    }
    return candidates.find(function (a) { return a.kind === 'web' && a.href.startsWith('https:'); }) ||
      candidates.find(function (a) { return a.kind === 'email'; }) || candidates[0] || null;
  }

  function find(header, safeHtml, text) {
    var action = fromHeader(header);
    if (action) return action;
    if (safeHtml) {
      var doc = new DOMParser().parseFromString(safeHtml, 'text/html');
      var links = doc.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var label = links[i].textContent.replace(/\s+/g, ' ').trim();
        if (label.length > 160 || !/\bunsubscribe\b/i.test(label) || /\b(not|never|don't)\b/i.test(label)) continue;
        action = parse(links[i].getAttribute('href'));
        if (action) return action;
      }
    }
    // Old plain-text mail can expose a labeled URL or an unsubscribe path.
    var lines = String(text || '').split(/\r?\n/);
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j], urls = line.match(/(?:https?:\/\/|mailto:)[^\s<>"\[\]]+/gi) || [];
      for (var k = 0; k < urls.length; k++) {
        var raw = urls[k].replace(/[.,;!?)]+$/, '');
        var labeled = /^(?:to\s+)?unsubscribe\b[\s:—–-]*(?:here\b[\s:]*)?$/i.test(line.slice(0, line.indexOf(urls[k])).trim().replace(/[\[<]$/, '').trim());
        var path = false;
        try { path = /(?:^|\/)(?:unsubscribe|opt[-_]?out)(?:\/|$)/i.test(new URL(raw).pathname); } catch (e) {}
        if (!labeled && !path) continue;
        action = parse(raw);
        if (action) return action;
      }
    }
    return null;
  }

  window.InprivUnsubscribe = { parse: parse, fromHeader: fromHeader, find: find };
})();
