// Common error pages (extracted from the deployed suite bundle — shared style)
const ESC = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function errorPage({ status, title, heading, intro, extra, primary, noteHtml }) {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${ESC(title)} · Inpriv</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
    background:#141218; color:#E6E1E3;
    font:380 16px/1.55 'Google Sans Text','Roboto Flex',system-ui,-apple-system,sans-serif; }
  .card { max-width:30rem; width:100%;
    background:#242229; border:1px solid #47464F; border-radius:24px; padding:28px 24px; }
  .code { font-weight:600; letter-spacing:1px; font-size:.8rem; color:#CBBEFF; text-transform:uppercase; }
  h1 { font-weight:480; font-size:1.5rem; margin:.5rem 0 .4rem; letter-spacing:.2px; }
  p { margin:0 0 1rem; color:#CBC4D4; font-size:.95rem; }
  .btn { display:inline-flex; align-items:center; gap:8px; text-decoration:none;
    background:#CBBEFF; color:#340098; font-weight:560; font-size:.95rem;
    border-radius:16px; padding:12px 20px; }
  .note { margin-top:1.2rem; font-size:.82rem; color:#948F99; }
  a.inline { color:#CBBEFF; }
</style>
</head>
<body>
<div class="card">
  <div class="code">Error ${status}</div>
  <h1>${ESC(heading)}</h1>
  <p>${intro}</p>
  ${primary ? `<a class="btn" href="${ESC(primary.href)}">${ESC(primary.label)}</a>` : ''}
  ${noteHtml ? `<div class="note">${noteHtml}</div>` : ''}
</div>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" }
  });
}

export function notFound(request, serviceName = "Inpriv") {
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
  if (!wantsHtml) return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404, headers: { "content-type": "application/json; charset=utf-8" }
  });
  return errorPage({
    status: 404,
    title: "Not found",
    heading: "This page does not exist",
    intro: `The address you opened is not part of ${serviceName}. Check the link or head back to the homepage.`,
    primary: { label: "Go home", href: "/" }
  });
}
