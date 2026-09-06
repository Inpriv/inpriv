# ruff: noqa
# Generate the OG card for Inpriv Check (2026-09-06) — Google M3 palette
# (dark default), matching the design system in .inpriv-labs/inpriv-labs.md.
import os, math
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
LOGO = Image.open(os.path.join(ROOT, ".hush", "icon.png")).convert("RGBA")

W, H = 1200, 630
BG = (20, 18, 24)        # #141218
SURFACE = (31, 29, 36)   # #1F1D24 container-low
PRIMARY = (203, 190, 255)  # #CBBEFF
TEXT = (230, 225, 227)   # #E6E1E3
MUTED = (203, 196, 212)  # #CBC4D4
LINE = (71, 70, 79)      # #47464F outline-variant
DOMAIN = (148, 143, 153) # #948F99

FB = "C:/Windows/Fonts/segoeuib.ttf"
FL = "C:/Windows/Fonts/segoeui.ttf"
FS = "C:/Windows/Fonts/segoeuil.ttf"
OUT = os.path.join(ROOT, "og")
os.makedirs(OUT, exist_ok=True)


def draw_check(d, cx, cy, r, col, lw):
    # shield with a check
    pts = []
    for i in range(0, 181, 5):
        a = math.radians(i)
        pts.append((cx + r * math.cos(a - math.pi / 2), cy + r * 0.9 * math.sin(a - math.pi / 2)))
    pts += [(cx - r, cy - r * 0.1), (cx, cy + r * 1.15), (cx + r, cy - r * 0.1)]
    d.polygon(pts, outline=col, width=lw)
    d.line([(cx - r * 0.42, cy + r * 0.05), (cx - r * 0.12, cy + r * 0.38), (cx + r * 0.48, cy - r * 0.3)],
           fill=col, width=max(6, lw + 2), joint="curve")


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

logo_size = 190
logo = LOGO.resize((logo_size, logo_size), Image.LANCZOS)
lx = (W - logo_size) // 2
ly = 78
img.paste(logo, (lx, ly), logo)

f_title = ImageFont.truetype(FB, 88)
ty = ly + logo_size + 56
d.text((W // 2, ty), "Inpriv Check", font=f_title, fill=TEXT, anchor="ma")

f_sub = ImageFont.truetype(FB, 40)
d.text((W // 2, ty + 122), "Code & File Security Scanner", font=f_sub, fill=PRIMARY, anchor="ma")

f_dom = ImageFont.truetype(FL, 32)
d.text((W // 2, H - 66), "check.inpriv.xyz", font=f_dom, fill=DOMAIN, anchor="ma")

# card chip at top-right: glyph
chip = Image.new("RGBA", (150, 150), (0, 0, 0, 0))
cd = ImageDraw.Draw(chip)
cd.rounded_rectangle([10, 10, 140, 140], radius=42, fill=(75, 33, 189, 255))
draw_check(cd, 75, 78, 46, (230, 222, 255, 255), 14)
img.paste(chip, (W - 190, 40), chip)

# card chip at bottom-left: three detection squares (signals)
ch2 = Image.new("RGBA", (210, 90), (0, 0, 0, 0))
c2 = ImageDraw.Draw(ch2)
for i, (col) in enumerate([(255, 134, 112, 255), (255, 184, 104, 255), (148, 143, 153, 255)]):
    c2.rounded_rectangle([10 + i * 70, 14, 62 + i * 70, 66], radius=18, outline=col, width=8)
img.paste(ch2, (52, H - 120), ch2)

path = os.path.join(OUT, "check.png")
img.save(path, "PNG", optimize=True)
print(path, os.path.getsize(path) // 1024, "KB")