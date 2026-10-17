# ruff: noqa
"""Inject full SEO blocks (OG / Twitter / canonical / JSON-LD / robots) into every
Inpriv service index.html (root + worker/public copies). Idempotent."""
import os, re, json, sys

BASE = os.path.dirname(os.path.abspath(__file__))

# key -> (domain, og-image key, index policy, category, fallback description)
SERVICES = {
    "id":       ("id.inpriv.xyz",       "id",       "index, follow", "SecurityApplication", "One private account for the whole Inpriv suite. Encrypted vault, @inpriv.xyz address, single sign-on."),
    "mail":     ("mail.inpriv.xyz",     "mail",     "index, follow", "SecurityApplication", "Zero-knowledge encrypted email. RSA-2048 + AES-GCM end-to-end, synchronized with Inpriv ID."),
    "temp":     ("temp.inpriv.xyz",     "temp",     "index, follow", "SecurityApplication", "Disposable email on inpriv.xyz. Random inbox, instant receive, one-click shred. No signup."),
}

OG_IMG = "https://inpriv.xyz/og/{k}.png"

def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))

def seo_block(domain, key, policy, category, desc, title):
    img = OG_IMG.format(k=key)
    ld = {
        "@context": "https://schema.org",
        "@type": category,
        "name": title,
        "url": f"https://{domain}/",
        "description": desc,
        "applicationCategory": category,
        "operatingSystem": "All",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "publisher": {"@type": "Organization", "name": "Inpriv Labs", "url": "https://inpriv.xyz/"},
        "inLanguage": "en",
    }
    ld.pop("applicationCategory") if category == "WebApplication" else None
    return f"""<meta property="og:type" content="website">
<meta property="og:site_name" content="Inpriv">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="https://{domain}/">
<meta property="og:image" content="{img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(title)}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{img}">
<meta name="twitter:image:alt" content="{esc(title)}">
<link rel="canonical" href="https://{domain}/">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>"""

def patch(html, domain, key, policy, category, fallback_desc):
    if 'property="og:title"' in html and 'twitter:card' in html and 'og:image:width' in html:
        return html, "already-done"
    m = re.search(r"<title>([^<]+)</title>", html)
    title = m.group(1).strip() if m else "Inpriv"
    dm = re.search(r'<meta name="description" content="([^"]*)"', html)
    desc = dm.group(1) if dm else fallback_desc
    notes = []
    # description fallback insert
    if not dm:
        html = html.replace("</title>", "</title>\n" + f'<meta name="description" content="{esc(fallback_desc)}">', 1)
        notes.append("desc-added")
    # robots
    if 'name="robots"' in html:
        if policy == "index, follow" and "noindex" in html.split('name="robots"')[1][:120]:
            html = re.sub(r'(<meta name="robots" content=")noindex, nofollow(")', r"\1index, follow\2", html, count=1)
            notes.append("robots-flipped")
    else:
        html = html.replace("</title>", "</title>\n" + f'<meta name="robots" content="{policy}">', 1)
        notes.append("robots-added")
    # canonical (if the injector's block adds one, skip separate)
    block = seo_block(domain, key, policy, category, desc, title)
    anchor = '<meta name="description"'
    idx = html.find(anchor)
    if idx == -1:
        idx = html.find("</title>") + len("</title>")
    else:
        idx = html.find(">", idx) + 1
    html = html[:idx] + "\n" + block + html[idx:]
    notes.append("seo-injected")
    return html, ",".join(notes)

targets = {}
for d, (domain, key, policy, category, fallback) in SERVICES.items():
    p = os.path.join(BASE, "." + d)
    for cand in [os.path.join(p, "index.html"), os.path.join(p, "worker", "public", "index.html")]:
        if os.path.exists(cand):
            targets[cand] = (domain, key, policy, category, fallback)

# admin: only add noindex robots if missing
admin = os.path.join(BASE, ".admin")
for cand in [os.path.join(admin, "index.html"), os.path.join(admin, "worker", "public", "index.html")]:
    if os.path.exists(cand):
        targets[cand] = ("admin.inpriv.xyz", None, "noindex, nofollow", None, None)

changed = 0
for path, (domain, key, policy, category, fallback) in sorted(targets.items()):
    html = open(path, encoding="utf-8", errors="ignore").read()
    if key is None:  # admin: robots only
        if 'name="robots"' not in html:
            html = html.replace("</title>", '</title>\n<meta name="robots" content="noindex, nofollow">', 1)
            open(path, "w", encoding="utf-8", newline="").write(html)
            print(f"{path}: admin-robots-added")
            changed += 1
        else:
            print(f"{path}: admin-skip")
        continue
    new, note = patch(html, domain, key, policy, category, fallback)
    if new != html:
        open(path, "w", encoding="utf-8", newline="").write(new)
        changed += 1
    print(f"{path}: {note}")

print(f"\n{changed} files changed of {len(targets)}")
