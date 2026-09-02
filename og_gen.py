# ruff: noqa
# Generate branded 1200x630 OG images for every Inpriv service.
# M3 Earthy Forest palette: dark #13140E bg, #ABD37A primary, #FAF9F0 text.
from PIL import Image, ImageDraw, ImageFont
import os, math

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

    # subtle radial glow behind glyph
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    gcx, gcy = 950, 200
    for rr in range(340, 0, -8):
        a = int(38 * ease(1 - rr/340))
        gd.ellipse([gcx-rr, gcy-rr, gcx+rr, gcy+rr], fill=a)
    img.paste(Image.new("RGB", (W, H), PRIMARY), (0, 0), glow)

    # faint grid
    for x in range(0, W, 60):
        d.line([(x, 0), (x, H)], fill=(24, 26, 19), width=1)
    for y in range(0, H, 60):
        d.line([(0, y), (W, y)], fill=(24, 26, 19), width=1)

    # top rule + brand
    d.line([(70, 78), (W-70, 78)], fill=LINE, width=2)
    f_brand = ImageFont.truetype(FB, 30)
    d.text((70, 96), "INPRIV LABS", font=f_brand, fill=PRIMARY)
    d.text((W-70, 96), "inpriv.xyz", font=ImageFont.truetype(FL, 26), fill=MUTED, anchor="ra")

    # glyph badge
    gcx, gcy, gr = 200, 330, 78
    d.rounded_rectangle([gcx-gr-26, gcy-gr-26, gcx+gr+26, gcy+gr+26], radius=44,
                        fill=SURFACE, outline=LINE, width=2)
    draw_glyph(d, glyph, gcx, gcy, gr, PRIMARY)

    # title + subtitle
    f_title = ImageFont.truetype(FB, 78)
    f_sub = ImageFont.truetype(FL, 34)
    tx = 340
    ty = 250
    d.text((tx, ty), title, font=f_title, fill=TEXT)
    # wrap subtitle
    words = subtitle.split(" ")
    lines, cur = [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if d.textlength(t, font=f_sub) <= 760:
            cur = t
        else:
            lines.append(cur); cur = w_
    lines.append(cur)
    yy = ty + 108
    for ln in lines[:3]:
        d.text((tx, yy), ln, font=f_sub, fill=MUTED)
        yy += 46

    # bottom rule + chips
    d.line([(70, H-96), (W-70, H-96)], fill=LINE, width=2)
    chips = ["Zero-Knowledge", "Client-Side", "Open Source"] if key != "landing" else ["21 Tools", "No Trackers", "No Server Logs"]
    f_chip = ImageFont.truetype(FS, 24)
    cx = 70
    for c in chips:
        wl = int(d.textlength(c, font=f_chip)) + 36
        d.rounded_rectangle([cx, H-72, cx+wl, H-28], radius=22, outline=LINE, width=2)
        d.text((cx+18, H-64), c, font=f_chip, fill=TEXT)
        cx += wl + 16

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
