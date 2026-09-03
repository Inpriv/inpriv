// Smoke test: labs.inpriv.xyz inline JS — device specs experiment
// Runs the extracted <script> in Node with a minimal DOM shim.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) { console.error('NO SCRIPT FOUND'); process.exit(1); }
const code = m[1];

const ctxStub = new Proxy({}, {
  get: (t, p) => {
    if (p === 'canvas') return null;
    return (...a) => ctxStub;
  },
  set: () => true,
});

function mkEl(tag) {
  const el = {
    tag, children: [], style: { cssText: '', setProperty() {} },
    dataset: {}, _text: '', _html: '', attrs: {}, width: 300, height: 150,
    value: '', checked: false, disabled: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return mkEl('x'); },
    querySelectorAll() { return []; },
    closest() { const e = mkEl('div'); e.style.display = ''; return e; },
    getContext() { return ctxStub; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    focus() {}, select() {}, click() {},
  };
  // innerHTML in the shim doesn't parse; simulate a stable parsed last child
  let vChild = null;
  Object.defineProperty(el, 'lastChild', {
    get() {
      if (this.children.length) return this.children[this.children.length - 1];
      if (!vChild) vChild = mkEl('span');
      return vChild;
    },
  });
  Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); } });
  Object.defineProperty(el, 'offsetWidth', { get() { return 100; } });
  return el;
}

const ids = {};
global.document = {
  documentElement: { dataset: {} },
  getElementById: (id) => ids[id] || (ids[id] = mkEl('div#' + id)),
  createElement: mkEl,
  querySelector() { return null; },
  querySelectorAll() { return []; },
  fonts: { check() { return false; } },
  body: mkEl('body'),
};
global.window = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.navigator = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  platform: 'Win32', language: 'en-US', languages: ['en-US', 'pl'],
  cookieEnabled: true, maxTouchPoints: 0, hardwareConcurrency: 8,
  onLine: true, doNotTrack: null, pdfViewerEnabled: true,
};
global.matchMedia = (q) => ({ matches: /srgb/.test(q) });
global.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, orientation: { type: 'landscape-primary' } };
global.innerWidth = 1200; global.innerHeight = 800; global.devicePixelRatio = 1;
global.performance = { memory: { jsHeapSizeLimit: 4294705152, usedJSHeapSize: 12345678, totalJSHeapSize: 23456789 }, now: () => Date.now() };
global.requestAnimationFrame = (fn) => setTimeout(() => fn(16.67), 1);
global.localStorage = { getItem() { return null; }, setItem() {} };
global.fetch = () => Promise.resolve({ json: async () => ({ ip: '203.0.113.7', country: 'PL', colo: 'WAW' }) });
global.serviceWorker = undefined;

let failed = false;
try {
  eval(code);
  console.log('EVAL: OK');
} catch (e) {
  console.error('EVAL FAILED:', e.message);
  console.error(e.stack && e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

setTimeout(() => {
  const t = (id) => (ids[id] ? ids[id].textContent : '<missing el>');
  console.log('--- initial state ---');
  console.log('dsFoot:', t('dsFoot'));
  console.log('dsIpText:', JSON.stringify(t('dsIpText')));
  console.log('dsIpLoc:', JSON.stringify(t('dsIpLoc')));
  console.log('dsColo:', JSON.stringify(t('dsColo')));

  // simulate IP reveal tap: the listener is registered on the real element;
  // our shim's addEventListener is a no-op, so call the flow manually via dispatch shim
  // -> instead verify the second-render path by re-checking foot text only.
  if (t('dsFoot').indexOf('parameters shown') === -1) { console.error('FAIL: dsFoot not populated'); failed = true; }
  if (t('dsIpText') !== '•••.•••.•••.•••') { console.error('FAIL: IP not masked initially:', t('dsIpText')); failed = true; }
  if (failed) process.exit(1);
  console.log('SMOKE: PASS');
  process.exit(0);
}, 500);
