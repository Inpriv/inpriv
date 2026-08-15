// Inpriv landing — static assets worker.
// Serves index.html, icon.png, /assets/* from the ASSETS binding.
// Preserve the legacy routes of the previous base64-embedded deployment:
//   /            → landing HTML
//   /index.html  → 307 → /
//   /robots.txt  → robots
// Everything else falls through to assets (icon.png, assets/icons/*.svg, …).
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/index.html") {
      return new Response(null, { status: 307, headers: { Location: "/" } });
    }

    // Assets binding serves /, /icon.png, /assets/…, /robots.txt (if present).
    return env.ASSETS.fetch(request);
  },
};
