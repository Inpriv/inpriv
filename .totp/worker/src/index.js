// totp.inpriv.xyz moved into Inpriv Vault. Permanent redirect keeps bookmarks working.
const TARGET = "https://vault.inpriv.xyz/totp/";

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
