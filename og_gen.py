# ruff: noqa
# Generate branded 1200x630 OG images for every Inpriv service.
# M3 Earthy Forest palette: dark #13140E bg, #ABD37A primary, #FAF9F0 text.
from PIL import Image, ImageDraw, ImageFont
import os, math

# real site logo — used in every OG card
LOGO = Image.open(os.path.join(os.path.dirname(__file__), ".hush", "icon.png")).convert("RGBA")

W, H = 1200, 630
BG = (19, 20, 14)        # #13140E
SURFACE = (26, 28, 23)   # rgba(26,28,23)
PRIMARY = (171, 211, 122)  # #ABD37A
TEXT = (227, 226, 211)   # #E3E2D3
MUTED = (168, 170, 155)
LINE = (60, 63, 52)

FB = "C:/Windows/Fonts/segoeuib.ttf"   # bold
FL = "C:/Windows/Fonts/segoeui.ttf"    # regular
FS = "C:/Windows/Fonts/segoeuil.ttf"   # light
OUT = os.path.join(os.path.dirname(__file__), "og")

SERVICES = [
    # key,          title,           subtitle,                          Material-ish glyph (drawn), accent
    ("landing", "Inpriv", "Privacy-First Tools. Zero-Knowledge. Client-Side.", "shield"),
    ("id",      "Inpriv ID", "One private account for the whole suite.", "person"),
    ("mail",    "Inpriv Mail", "Zero-Knowledge Encrypted Email", "mail"),
    ("temp",    "Inpriv Temp", "Disposable Email. No Signup. No Logs.", "timer"),
    ("fake",    "Inpriv Fake", "Time-Limited Identities. Burnable. Untraceable.", "visibility_off"),
    ("host",    "Inpriv Host", "Private Static Hosting with a Privacy Shield", "cloud"),
    ("share",   "Inpriv Share", "P2P File Transfer. E2E Encrypted. Server Never Sees Files.", "sync_alt"),
    ("burn",    "Inpriv Burn", "Ephemeral Encrypted Notes. Read Once, Then Gone.", "local_fire_department"),
    ("trace",   "Inpriv Trace", "IP, DNS & WebRTC Leak Test", "radar"),
    ("censor",  "Inpriv Censor", "Screenshot Redaction with ML Detection", "blur_on"),
    ("qr",      "Inpriv QR", "Generate & Read QR Codes. 100% Client-Side.", "qr_code_2"),
    ("wipe",    "Inpriv Wipe", "EXIF Metadata Sanitizer", "auto_fix_high"),
    ("compress","Inpriv Compress", "Private Image Compression. No Uploads.", "compress"),
    ("hash",    "Inpriv Hash", "Client-Side Checksum & Digest Tool", "fingerprint"),
    ("keyring", "Inpriv Keyring", "Zero-Knowledge Encrypted Secret Vault", "key"),
    ("brute",   "Inpriv Brute", "Hash Brute Force Matcher", "bolt"),
    ("totp",    "Inpriv TOTP", "Authenticator & 2FA Codes", "shield_lock"),
    ("pay",     "Inpriv Pay", "Encrypted Payment Links", "payment"),
    ("stego",   "Inpriv Stego", "Hide Messages Inside Images", "image"),
    ("status",  "Inpriv Status", "Suite Health & 7-Day Uptime", "monitor_heart"),
    ("labs",    "Inpriv Labs", "Experiments & Concepts", "science"),
    ("hush",    "Hush", "End-to-End Encrypted Chat. No Logs. No Servers.", "forum"),
]

def ease(t):
    return t * t * (3 - 2 * t)

def draw_glyph(d, name, cx, cy, r, col):
    # minimal geometric glyphs (Material-style), drawn with primitives
    lw = max(6, r // 9)
    if name == "shield":
        # shield outline + keyhole
        pts = []
        for i in range(0, 181, 5):
            a = math.radians(i)
            pts.append((cx + r * math.cos(a - math.pi/2), cy + r*0.9 * math.sin(a - math.pi/2)))
        pts += [(cx - r, cy - r*0.1), (cx, cy + r*1.15), (cx + r, cy - r*0.1)]
        d.polygon(pts, outline=col, width=lw)
        rr = r * 0.22
        d.ellipse([cx-rr, cy-rr*1.6, cx+rr, cy+rr*0.6], outline=col, width=lw)
        d.line([cx, cy+rr*0.5, cx, cy+r*0.55], fill=col, width=lw)
    elif name == "person":
        d.ellipse([cx-r*0.42, cy-r*0.95, cx+r*0.42, cy-r*0.11], outline=col, width=lw)
        d.arc([cx-r*0.85, cy-r*0.05, cx+r*0.85, cy+r*1.35], 180, 360, fill=col, width=lw)
    elif name == "mail":
        d.rounded_rectangle([cx-r, cy-r*0.62, cx+r, cy+r*0.62], radius=r*0.16, outline=col, width=lw)
        d.line([cx-r*0.92, cy-r*0.45, cx, cy+r*0.15], fill=col, width=lw)
        d.line([cx, cy+r*0.15, cx+r*0.92, cy-r*0.45], fill=col, width=lw)
    elif name == "timer":
        d.ellipse([cx-r*0.8, cy-r*0.7, cx+r*0.8, cy+r*0.9], outline=col, width=lw)
        d.line([cx, cy, cx, cy-r*0.42], fill=col, width=lw)
        d.line([cx, cy, cx+r*0.28, cy+r*0.18], fill=col, width=lw)
        d.line([cx-r*0.28, cy-r*0.92, cx+r*0.28, cy-r*0.92], fill=col, width=lw)
    elif name == "visibility_off":
        d.arc([cx-r, cy-r*0.5, cx+r, cy+r*1.0], 200, 340, fill=col, width=lw)
        d.arc([cx-r, cy-r*1.0, cx+r, cy+r*0.5], 20, 160, fill=col, width=lw)
        d.line([cx-r*0.95, cy+r*0.55, cx+r*0.95, cy-r*0.55], fill=col, width=lw)
    elif name == "cloud":
        d.arc([cx-r*0.75, cy-r*0.55, cx+r*0.05, cy+r*0.25], 90, 270, fill=col, width=lw)
        d.arc([cx-r*0.2, cy-r*0.85, cx+r*0.7, cy+r*0.05], 180, 360, fill=col, width=lw)
        d.line([cx-r*0.72, cy-r*0.15, cx-r*0.75, cy+r*0.3], fill=col, width=lw)
        d.line([cx-r*0.75, cy+r*0.3, cx+r*0.65, cy+r*0.3], fill=col, width=lw)
        d.line([cx+r*0.65, cy+r*0.3, cx+r*0.68, cy-r*0.35], fill=col, width=lw)
    elif name == "sync_alt":
        d.arc([cx-r*0.85, cy-r*0.6, cx+r*0.35, cy+r*0.6], 90, 300, fill=col, width=lw)
        d.arc([cx-r*0.35, cy-r*0.6, cx+r*0.85, cy+r*0.6], 270, 480, fill=col, width=lw)
        # arrowheads
        d.polygon([(cx+r*0.30, cy-r*0.72), (cx+r*0.30, cy-r*0.28), (cx-r*0.05, cy-r*0.50)], fill=col)
        d.polygon([(cx-r*0.30, cy+r*0.72), (cx-r*0.30, cy+r*0.28), (cx+r*0.05, cy+r*0.50)], fill=col)
    elif name == "local_fire_department":
        d.polygon([(cx, cy-r), (cx+r*0.5, cy-r*0.1), (cx+r*0.28, cy+r*0.85),
                   (cx-r*0.28, cy+r*0.85), (cx-r*0.5, cy-r*0.1)], outline=col, width=lw)
        d.polygon([(cx, cy-r*0.25), (cx+r*0.22, cy+r*0.35), (cx, cy+r*0.8),
                   (cx-r*0.22, cy+r*0.35)], outline=col, width=lw//2)
    elif name == "radar":
        d.arc([cx-r, cy-r, cx+r, cy+r], 0, 360, fill=col, width=lw)
        d.arc([cx-r*0.55, cy-r*0.55, cx+r*0.55, cy+r*0.55], 0, 360, fill=col, width=lw//2+2)
        d.line([cx, cy, cx+r*0.62, cy-r*0.62], fill=col, width=lw)
        d.ellipse([cx-lw, cy-lw, cx+lw, cy+lw], fill=col)
    elif name == "blur_on":
        rows = [(-0.6, -0.5), (0.0, -0.6), (0.6, -0.5), (-0.7, 0.1), (-0.15, 0.0), (0.4, 0.05),
                (0.8, 0.0), (-0.5, 0.6), (0.1, 0.65), (0.65, 0.6)]
        rr = r * 0.11
        for fx, fy in rows:
            x, y = cx+fx*r, cy+fy*r
            d.ellipse([x-rr, y-rr, x+rr, y+rr], outline=col, width=max(3, lw//2))
    elif name == "qr_code_2":
        s = r * 0.38
        for ox in (-1, 1):
            for oy in (-1, 1):
                x0, y0 = cx+ox*s - s*0.55, cy+oy*s - s*0.55
                d.rectangle([x0, y0, x0+s*1.1, y0+s*1.1], outline=col, width=lw//2+2)
                d.rectangle([x0+s*0.32, y0+s*0.32, x0+s*0.78, y0+s*0.78], fill=col)
        for fx, fy in [(0.1, -0.7), (0.55, -0.3), (-0.65, 0.4), (0.2, 0.55), (0.6, 0.7), (-0.2, 0.1)]:
            x, y = cx+fx*r*0.9, cy+fy*r*0.9
            d.rectangle([x-r*0.06, y-r*0.06, x+r*0.06, y+r*0.06], fill=col)
    elif name == "auto_fix_high":
        d.line([cx, cy-r, cx, cy+r], fill=col, width=lw)
        d.line([cx-r, cy, cx+r, cy], fill=col, width=lw)
        d.line([cx-r*0.55, cy-r*0.55, cx-r*0.2, cy-r*0.2], fill=col, width=lw)
        d.line([cx+r*0.2, cy+r*0.2, cx+r*0.55, cy+r*0.55], fill=col, width=lw)
        d.line([cx+r*0.55, cy-r*0.55, cx+r*0.2, cy-r*0.2], fill=col, width=lw)
        d.line([cx-r*0.2, cy+r*0.2, cx-r*0.55, cy+r*0.55], fill=col, width=lw)
        for fx, fy in [(0.75, -0.45), (0.95, -0.2)]:
            x, y = cx+fx*r, cy+fy*r
            d.line([x, y-r*0.09, x, y+r*0.09], fill=col, width=lw//2)
            d.line([x-r*0.09, y, x+r*0.09, y], fill=col, width=lw//2)
    elif name == "compress":
        d.line([cx-r*0.8, cy-r*0.95, cx+r*0.8, cy-r*0.95], fill=col, width=lw)
        d.line([cx-r*0.8, cy+r*0.95, cx+r*0.8, cy+r*0.95], fill=col, width=lw)
        for s in (-1, 1):
            y0 = cy - s*r*0.45
            d.line([cx, y0 + s*r*0.25, cx, y0 - s*r*0.25], fill=col, width=lw)
            d.polygon([(cx-r*0.22, y0 - s*r*0.05), (cx+r*0.22, y0 - s*r*0.05), (cx, y0 + s*r*0.3)], fill=col)
    elif name == "fingerprint":
        for k in range(3):
            rr = r * (0.25 + 0.32*k)
            d.arc([cx-rr, cy-rr*1.1, cx+rr, cy+rr*1.1], -60, 240, fill=col, width=lw//2+2)
        d.line([cx, cy-r*0.15, cx, cy+r*0.75], fill=col, width=lw//2+2)
    elif name == "key":
        d.ellipse([cx-r*0.75, cy-r*0.35, cx-r*0.05, cy+r*0.35], outline=col, width=lw)
        d.line([cx-r*0.05, cy, cx+r*0.9, cy], fill=col, width=lw)
        d.line([cx+r*0.55, cy, cx+r*0.55, cy+r*0.3], fill=col, width=lw)
        d.line([cx+r*0.85, cy, cx+r*0.85, cy+r*0.4], fill=col, width=lw)
    elif name == "bolt":
        d.polygon([(cx+r*0.1, cy-r), (cx-r*0.55, cy+r*0.12), (cx-r*0.05, cy+r*0.12),
                   (cx-r*0.15, cy+r), (cx+r*0.55, cy-r*0.12), (cx+r*0.05, cy-r*0.12)], outline=col, width=lw)
    elif name == "shield_lock":
        pts = []
        for i in range(0, 181, 5):
            a = math.radians(i)
            pts.append((cx + r * math.cos(a - math.pi/2), cy + r*0.9 * math.sin(a - math.pi/2)))
        pts += [(cx - r, cy - r*0.1), (cx, cy + r*1.15), (cx + r, cy - r*0.1)]
        d.polygon(pts, outline=col, width=lw)
        d.rounded_rectangle([cx-r*0.32, cy-r*0.15, cx+r*0.32, cy+r*0.5], radius=r*0.08, outline=col, width=lw//2+2)
        d.arc([cx-r*0.2, cy-r*0.55, cx+r*0.2, cy-r*0.1], 180, 360, fill=col, width=lw//2+2)
    elif name == "payment":
        d.rounded_rectangle([cx-r*0.9, cy-r*0.6, cx+r*0.9, cy+r*0.6], radius=r*0.14, outline=col, width=lw)
        d.line([cx-r*0.9, cy-r*0.22, cx+r*0.9, cy-r*0.22], fill=col, width=lw)
        d.line([cx-r*0.6, cy+r*0.25, cx-r*0.15, cy+r*0.25], fill=col, width=lw)
    elif name == "image":
        d.rounded_rectangle([cx-r*0.85, cy-r*0.7, cx+r*0.85, cy+r*0.7], radius=r*0.12, outline=col, width=lw)
        d.ellipse([cx-r*0.5, cy-r*0.42, cx-r*0.22, cy-r*0.14], outline=col, width=lw//2+2)
        d.line([cx-r*0.85, cy+r*0.35, cx-r*0.15, cy-r*0.2], fill=col, width=lw)
        d.line([cx+r*0.05, cy+r*0.28, cx+r*0.45, cy-r*0.05], fill=col, width=lw)
        d.line([cx+r*0.45, cy-r*0.05, cx+r*0.85, cy+r*0.3], fill=col, width=lw)
    elif name == "monitor_heart":
        d.rounded_rectangle([cx-r*0.9, cy-r*0.65, cx+r*0.9, cy+r*0.65], radius=r*0.12, outline=col, width=lw)
        pts = [(cx-r*0.6, cy), (cx-r*0.35, cy), (cx-r*0.22, cy-r*0.3), (cx+r*0.02, cy+r*0.3),
               (cx+r*0.18, cy), (cx+r*0.6, cy)]
        d.line(pts, fill=col, width=lw, joint="curve")
        d.line([cx-r*0.3, cy+r*0.95, cx+r*0.3, cy+r*0.95], fill=col, width=lw)
    elif name == "science":
        d.line([cx-r*0.25, cy-r*0.85, cx+r*0.25, cy-r*0.85], fill=col, width=lw)
        d.line([cx-r*0.13, cy-r*0.85, cx-r*0.13, cy-r*0.15], fill=col, width=lw)
        d.line([cx+r*0.13, cy-r*0.85, cx+r*0.13, cy-r*0.15], fill=col, width=lw)
        d.polygon([(cx-r*0.55, cy+r*0.8), (cx+r*0.55, cy+r*0.8), (cx+r*0.13, cy-r*0.15), (cx-r*0.13, cy-r*0.15)],
                  outline=col, width=lw)
        d.ellipse([cx-r*0.1, cy+r*0.35, cx+r*0.1, cy+r*0.55], outline=col, width=lw//2+2)
    elif name == "forum":
        d.rounded_rectangle([cx-r*0.9, cy-r*0.7, cx+r*0.45, cy+r*0.3], radius=r*0.14, outline=col, width=lw)
        d.polygon([(cx-r*0.55, cy+r*0.3), (cx-r*0.55, cy+r*0.62), (cx-r*0.25, cy+r*0.3)], fill=col)
        d.rounded_rectangle([cx+r*0.0, cy-r*0.25, cx+r*0.9, cy+r*0.55], radius=r*0.14, outline=col, width=lw)
        d.polygon([(cx+r*0.55, cy+r*0.55), (cx+r*0.8, cy+r*0.85), (cx+r*0.8, cy+r*0.55)], fill=col)
    elif name == "link":
        d.arc([cx-r*0.8, cy-r*0.35, cx+r*0.1, cy+r*0.55], 100, 320, fill=col, width=lw)
        d.arc([cx-r*0.1, cy-r*0.55, cx+r*0.8, cy+r*0.35], 280, 500, fill=col, width=lw)
        d.line([cx-r*0.35, cy+r*0.15, cx+r*0.35, cy-r*0.15], fill=col, width=lw)

def make(key, title, subtitle, glyph):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # ── clean minimal card ──
    # logo left, vertically centered
    logo_size = 170
    logo = LOGO.resize((logo_size, logo_size), Image.LANCZOS)
    lx, ly = 120, (H - logo_size) // 2
    img.paste(logo, (lx, ly), logo)

    # title + short tagline right of the logo
    tx = lx + logo_size + 70
    f_title = ImageFont.truetype(FB, 96)
    d.text((tx, H // 2 - 128), title, font=f_title, fill=TEXT)

    # shorten subtitle to first sentence, wrap to max 2 lines
    short = subtitle.split(". ")[0].rstrip(".") + "."
    f_sub = ImageFont.truetype(FL, 40)
    words = short.split(" ")
    lines, cur = [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if d.textlength(t, font=f_sub) <= 700:
            cur = t
        else:
            lines.append(cur); cur = w_
    lines.append(cur)
    yy = H // 2 + 22
    for ln in lines[:2]:
        d.text((tx, yy), ln, font=f_sub, fill=MUTED)
        yy += 54

    # single small brand mark bottom-left
    d.text((120, H - 92), "inpriv.xyz", font=ImageFont.truetype(FL, 30), fill=(120, 122, 108))

    path = os.path.join(OUT, f"{key}.png")
    img.save(path, "PNG", optimize=True)
    return path, os.path.getsize(path)

os.makedirs(OUT, exist_ok=True)
total = 0
for svc in SERVICES:
    p, sz = make(*svc)
    total += sz
    print(f"{p}  {sz//1024} KB")
print(f"TOTAL {total//1024} KB, {len(SERVICES)} images")
