// ── Inbound email HTML: strip active content before storing (shared) ────────
// First of two layers. Here, at receive time, Mail and Temp remove anything
// that runs or acts: scripts, frames, plugins, forms, meta refresh, <base>,
// <link>, event handlers and script URLs. It uses the Workers HTMLRewriter
// (an HTML parser), not regular expressions.
//
// Remote images and stylesheet URLs are left in place on purpose: blocking
// them is the reader's job (common/ui/mail-render.js), because the person
// can choose to load images for one message. The reader also renders in a
// sandboxed frame with its own Content-Security-Policy.

const DROP = [
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea", "option", "base", "link", "meta",
  "template", "portal", "math", "svg", "audio", "video", "source", "track", "canvas",
];
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "background", "poster", "data", "lowsrc", "dynsrc", "cite", "longdesc", "srcset", "ping"]);

function unsafeUrl(v) {
  const s = String(v || "").replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
  return s.startsWith("javascript:") || s.startsWith("vbscript:") || s.startsWith("file:") ||
    (s.startsWith("data:") && !/^data:image\/(png|gif|jpe?g|webp);/.test(s));
}

export async function sanitizeEmailHtml(html) {
  if (!html) return "";
  const rw = new HTMLRewriter();
  for (const tag of DROP) rw.on(tag, { element(el) { el.remove(); } });
  rw.on("*", {
    element(el) {
      // collect first: removing while iterating the live attribute list skips entries
      const names = [...el.attributes].map(([n]) => n);
      for (const n of names) {
        const v = el.getAttribute(n);
        if (n.startsWith("on") || n === "srcdoc" || n === "ping" || n === "formaction") el.removeAttribute(n);
        else if (URL_ATTRS.has(n) && unsafeUrl(v)) el.removeAttribute(n);
        else if (n === "style" && /expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(v || "")) el.removeAttribute(n);
      }
    },
  });
  const out = await rw.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
  return out.trim();
}
