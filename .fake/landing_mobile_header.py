#!/usr/bin/env python3
"""Inject the fake-style mobile floating glass header into the LANDING page.

Landing (inpriv.xyz) header is <nav class="top-header"> inside .container,
with an ID chip + lang + theme buttons. This patch makes ONLY the mobile
(<600px) view render it as the floating glass pill: brand icon chip,
compact ID chip (icon-only), tagline hidden, springy barIn entrance.
Desktop untouched.
"""
import re, io

BASE = "C:/Users/mckkw/Desktop/Private/.projects/inpriv"

MOBILE_CSS = """
<style data-inpriv-mobile-header>
/* ── mobile floating glass header (fake.inpriv.xyz style) — <600px only ── */
@media (max-width: 599.98px) {
  .top-header {
    position: sticky; top: 12px; z-index: 50;
    margin: 0 0 22px; padding: 6px 6px 6px 12px;
    gap: 8px; align-items: center;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--md-surface-container, #1F211B) 80%, transparent);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid color-mix(in srgb, var(--md-outline-variant, #43483D) 50%, transparent);
    box-shadow: 0 4px 20px -4px rgba(0,0,0,.4);
    animation: thBarIn .7s cubic-bezier(.2,1.4,0,1) both;
  }
  @keyframes thBarIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
  .top-header .brand { align-items: center; gap: 9px; }
  .top-header .brand-title { font-size: 17px; white-space: nowrap; }
  .top-header .brand-tagline { display: none; }
  .top-header .brand-icon {
    width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
    background: var(--md-primary-container, #2E4F2F); color: var(--md-on-primary-container, #C7EFA0);
    display: grid; place-items: center;
  }
  .top-header .brand-icon .icon { font-size: 17px; }
  .top-header .header-actions { gap: 2px; flex-wrap: nowrap; }
  .top-header .icon-btn { width: 40px; height: 40px; flex-shrink: 0; }
  .top-header .app-bar-id-chip { width: 40px; height: 40px; padding: 0; justify-content: center; gap: 0; flex-shrink: 0; }
  .top-header .app-bar-id-chip > span:not(.icon) { display: none; }
  .top-header .app-bar-id-chip .icon { font-size: 19px; }
}
</style>
"""

BRAND_ICON = '<span class="brand-icon" aria-hidden="true"><span class="icon">shield</span></span>'

def patch(path):
    html = io.open(path, encoding="utf-8").read()
    if "data-inpriv-mobile-header" in html:
        print("  already patched, skip")
        return False
    # 1. inject brand icon before the brand-title div (landing brand has no icon)
    m = re.search(r'(<nav class="top-header"[^>]*>\s*<div class="brand">\s*)(<div>\s*<div class="brand-title">)', html)
    if not m:
        print("  header anchor not found")
        return False
    html = html[:m.end(1)] + BRAND_ICON + html[m.end(1):]
    # 2. append the mobile CSS right before </head>
    idx = html.rfind("</head>")
    html = html[:idx] + MOBILE_CSS + html[idx:]
    io.open(path, "w", encoding="utf-8", newline="").write(html)
    print("  patched")
    return True

if __name__ == "__main__":
    patch(f"{BASE}/worker/public/index.html")   # the copy the worker serves
    patch(f"{BASE}/index.html")                 # repo-root twin
