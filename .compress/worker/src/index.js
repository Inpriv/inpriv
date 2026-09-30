// compress.inpriv.xyz moved into Inpriv Image. Permanent redirect keeps bookmarks working.
const TARGET = "https://image.inpriv.xyz/";
const MODE = "compress";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, redirect: TARGET + "#" + MODE }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(null, {
      status: 301,
      headers: { Location: TARGET + "#" + MODE, "Cache-Control": "public, max-age=3600" },
    });
  },
};
