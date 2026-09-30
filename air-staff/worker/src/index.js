// air.inpriv.xyz moved to Inpriv Labs (labs.inpriv.xyz/air/). Permanent redirect keeps bookmarks working.
const TARGET = "https://labs.inpriv.xyz/air/";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, redirect: TARGET }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(null, {
      status: 301,
      headers: { Location: TARGET, "Cache-Control": "public, max-age=3600" },
    });
  },
};
