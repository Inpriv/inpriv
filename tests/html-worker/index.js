// Test-only Worker (never deployed): exposes common/email-html.js so the
// HTMLRewriter sanitizer can be tested in the real Workers runtime.
import { sanitizeEmailHtml } from "../../common/email-html.js";

export default {
  async fetch(request) {
    return new Response(await sanitizeEmailHtml(await request.text()), { headers: { "Content-Type": "text/plain" } });
  },
};
