#!/usr/bin/env python3
"""Inject fake.inpriv.xyz-style mobile app-bar into every Inpriv service header.

Fake's header style (the suite standard on mobile):
  - sticky, floating glass pill (inset 12px, 9999px radius, blur+saturate)
  - brand icon in a rounded container + "name<accent>.</accent>" nowrap
  - actions: icon buttons become 44px circles, privacy pills compact to icon
    + label, tagline hidden on mobile
  - entrance animation barIn, springy hovers; safe-area padding
PC (>=600px): NOTHING changes — every rule lives inside @media (max-width: 599.98px).

Per-service knobs (SERVICE tune table below):
  align:  ""            header is inside the page's centered column (default)
          "selfcenter"  header is a direct child of body → needs its own centering
  wrap:   ""            default behavior (pill → icon-only, hide tagline/label)
          "keep"        keep privacy pill text (short pills: "24h", "Non-Custodial")
  icon:   material symbol name used when the pill collapses to icon-only
  hide:   extra selector to hide on mobile inside the header (e.g. long labels)
"""
import re, sys, io

# service → (align, wrap, pill icon, extra hide selectors in header)
SERVICES = {
    "host":     ("selfcenter", "",     "verified_user", []),
    "mail":     ("selfcenter", "",     "verified_user", ["#idStatusContainer"]),
    "temp":     ("selfcenter", "keep", "schedule",      []),
    "keyring":  ("selfcenter", "",     "key",           []),
    "burn":     ("selfcenter", "",     "local_fire_department", []),
    "qr":       ("selfcenter", "",     "qr_code_2",     []),
    "hash":     ("selfcenter", "",     "tag",           []),
    "brute":    ("selfcenter", "",     "shield",        []),
    "totp":     ("selfcenter", "",     "pin",           []),
    "stego":    ("selfcenter", "",     "hide_image",    []),
    "censor":   ("selfcenter", "",     "privacy_tip",   ["#backBtn"]),
    "trace":    ("selfcenter", "",     "travel_explore", ["#exportBtn"]),
    "compress": ("selfcenter", "keep", "compress",      []),
    "pay":      ("selfcenter", "keep", "payments",      []),
    "id":       ("selfcenter", "",     "badge",         []),
}

BASE = r"C:/Users/mckkw/Desktop/Private/.projects/inpriv"

MOBILE_CSS = """
/* ── mobile floating glass app-bar (fake.inpriv.xyz style) — <600px only ── */
@media (max-width: 599.98px) {{
  .top-header {{
    position: sticky; top: 12px; z-index: 50;
    max-width: none; width: auto; margin: 12px 12px 22px; padding: 6px 6px 6px 14px;
    gap: 8px; align-items: center;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--md-surface-container, #1F211B) 80%, transparent);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid color-mix(in srgb, var(--md-outline-variant, #43483D) 50%, transparent);
    box-shadow: 0 4px 20px -4px rgba(0,0,0,.4);
    animation: thBarIn .7s cubic-bezier(.2,1.4,0,1) both;
  }}
  @keyframes thBarIn {{ from {{ opacity: 0; transform: translateY(-12px); }} to {{ opacity: 1; transform: translateY(0); }} }}
  .top-header .brand {{ align-items: center; gap: 10px; }}
  .top-header .brand-title {{ font-size: 17px; white-space: nowrap; }}
  .top-header .brand-tagline {{ display: none; }}
  {brand_icon_css}
  .top-header .header-actions {{ gap: 2px; flex-wrap: nowrap; }}
  .top-header .icon-btn {{ width: 40px; height: 40px; flex-shrink: 0; }}
  {pill_css}
  {hide_css}
  {brandicon_img_css}
}}
"""

BRAND_ICON_HTML = """<span class="brand-icon" aria-hidden="true"><span class="material-symbols-rounded">{icon}</span></span>"""

BRAND_ICON_CSS = """
  .top-header .brand-icon {
    width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
    background: var(--md-primary-container, #2E4F2F); color: var(--md-on-primary-container, #C7EFA0);
    display: grid; place-items: center;
  }
  .top-header .brand-icon .material-symbols-rounded { font-size: 19px; }"""

BRAND_ICON_SCAN = """
  .top-header .brand-icon:empty {
    width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
    background: var(--md-primary-container, #2E4F2F); color: var(--md-on-primary-container, #C7EFA0);
    display: grid; place-items: center;
  }
  .top-header .brand-icon:empty::before { content: 'theater_comedy'; font-family: 'Material Symbols Rounded'; font-size: 19px; }"""

PILL_ICON_ONLY = """
  .top-header .privacy-pill { padding: 0; border: none; background: transparent; box-shadow: none; min-width: 40px; height: 40px; justify-content: center; border-radius: 50%; flex-shrink: 0; }
  .top-header .privacy-pill > span:not(.material-symbols-rounded):not(.ms):not(.icon) { display: none; }
  .top-header .privacy-pill .material-symbols-rounded,
  .top-header .privacy-pill .ms,
  .top-header .privacy-pill .icon { font-size: 21px; }"""

PILL_COMPACT = """
  .top-header .privacy-pill { padding: 6px 12px 6px 10px; gap: 5px; font-size: 11px; border-radius: 9999px; flex-shrink: 0; }
  .top-header .privacy-pill .material-symbols-rounded,
  .top-header .privacy-pill .ms,
  .top-header .privacy-pill .icon { font-size: 16px; }"""

def find_header_span(html):
    """Locate <header class="top-header"> ... </header> (or <nav)."""
    m = re.search(r'<(header|nav)\s+class="top-header"[^>]*>', html)
    if not m:
        return None
    start = m.start()
    tag = m.group(1)
    end = html.find(f"</{tag}>", start)
    if end == -1:
        return None
    return start, end + len(f"</{tag}>")

def process(service, align, wrap, pill_icon, hide_extra):
    path = f"{BASE}/.{service}/worker/public/index.html"
    html = io.open(path, encoding="utf-8").read()
    if "thBarIn" in html:
        print(f"  {service}: already patched, skip")
        return False
    span = find_header_span(html)
    if not span:
        print(f"  {service}: NO top-header markup found, skip")
        return False
    s, e = span
    header = html[s:e]

    # 1. inject brand icon right after the brand container opens (before title div).
    # Never inject if the page already defines .brand-icon elsewhere (topbar etc.)
    # — a second .brand-icon span would inherit that styling and render wrong.
    page_defines_brand_icon = bool(re.search(r'\.brand-icon\s*\{', html[:s]))
    brand_re = re.compile(r'(<div class="brand">\s*)(<div>\s*<div class="brand-title">)')
    injected = False
    if not page_defines_brand_icon:
        icon_html = BRAND_ICON_HTML.format(icon=pill_icon)
        if brand_re.search(header):
            header_new = brand_re.sub(lambda m: m.group(1) + icon_html + m.group(2), header, count=1)
            injected = header_new != header
        else:
            # censor: brand contains a button first; insert icon before the title div
            title_re = re.compile(r'(<div class="brand">)(.*?)(<div>\s*<div class="brand-title">)', re.S)
            m2 = title_re.search(header)
            if m2:
                header_new = title_re.sub(lambda m: m.group(1) + m.group(2) + icon_html + m.group(3), header, count=1)
                injected = True
    if not injected:
        icon_html = ""
        header_new = header
    header = header_new

    # 2. hide-list selectors need the header scope
    hide_css = ""
    if hide_extra:
        scoped = [f".top-header {sel}" for sel in hide_extra]
        hide_css = "  " + ", ".join(scoped) + " { display: none; }"

    pill_css = PILL_COMPACT if wrap == "keep" else PILL_ICON_ONLY
    align_css = ""
    if align == "selfcenter":
        # header is direct child of body → fake-style page centering on mobile
        align_css = (
            "  .top-header { margin-left: auto; margin-right: auto; }\n"
        )

    css = MOBILE_CSS.format(
        brand_icon_css=BRAND_ICON_CSS if injected else BRAND_ICON_SCAN,
        pill_css=pill_css,
        hide_css=hide_css,
        brandicon_img_css="",
        align_css=align_css,
    )
    css = css.replace("{align_css}", align_css)  # safety (str.format already handled)
    # remove the empty placeholder lines if any
    css = "\n".join([ln for ln in css.split("\n") if ln.strip() not in ("{brand_icon_css}", "{pill_css}", "{hide_css}", "{brandicon_img_css}")])

    style_block = f"\n<style data-inpriv-mobile-header>{css}</style>\n"

    html = html[:e] + style_block + html[e:]
    io.open(path, "w", encoding="utf-8", newline="").write(html)
    print(f"  {service}: patched (align={align}, pill={'compact' if wrap=='keep' else 'icon-only'})")
    return True

def main():
    only = sys.argv[1:] or list(SERVICES.keys())
    ok = 0
    for svc in only:
        if svc not in SERVICES:
            print(f"  {svc}: unknown"); continue
        if process(svc, *SERVICES[svc]):
            ok += 1
    print(f"patched {ok}/{len(only)}")

if __name__ == "__main__":
    main()
