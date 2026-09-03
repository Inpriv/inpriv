# ruff: noqa
# One-off: dark social preview (1280x640) for the Inpriv/inpriv GitHub repo.
# Same M3 Earthy Forest palette as og_gen.py: dark #13140E bg, #ABD37A primary.
from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.dirname(os.path.abspath(__file__))
LOGO = Image.open(os.path.join(BASE, ".hush", "icon.png")).convert("RGBA")

W, H = 1280, 640
BG = (19, 20, 14)          # #13140E
SURFACE = (26, 28, 23)     # #1A1C17
PRIMARY = (171, 211, 122)  # #ABD37A
TEXT = (227, 226, 211)     # #E3E2D3
MUTED = (168, 170, 155)
FAINT = (122, 124, 110)
LINE = (60, 63, 52)

FB = "C:/Windows/Fonts/segoeuib.ttf"
FL = "C:/Windows/Fonts/segoeui.ttf"
FS = "C:/Windows/Fonts/segoeuil.ttf"

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# subtle surface card, like the suite OG cards
m = 40
d.rounded_rectangle([m, m, W - m, H - m], radius=36, fill=SURFACE, outline=LINE, width=2)

# real logo, left side
logo_size = 170
logo = LOGO.resize((logo_size, logo_size), Image.LANCZOS)
lx, ly = 110, 108
img.paste(logo, (lx, ly), logo)

# wordmark next to the logo
d.text((lx + logo_size + 44, ly + 10), "Inpriv", font=ImageFont.truetype(FB, 96), fill=TEXT, anchor="la")
d.text((lx + logo_size + 48, ly + 122), "by Inpriv Labs", font=ImageFont.truetype(FL, 34), fill=MUTED, anchor="la")

# repo line
d.text((110, 330), "Inpriv/inpriv", font=ImageFont.truetype(FB, 84), fill=PRIMARY, anchor="la")

# tagline
d.text((112, 442), "Zero-knowledge privacy tools. Client-side only.", font=ImageFont.truetype(FS, 40), fill=TEXT, anchor="la")
d.text((112, 498), "No trackers. No remote logs. No compromises.", font=ImageFont.truetype(FS, 34), fill=MUTED, anchor="la")

# bottom: repo URL
d.text((110, H - 108), "github.com/Inpriv/inpriv", font=ImageFont.truetype(FL, 30), fill=FAINT, anchor="la")

# thin accent line, bottom of card
d.rounded_rectangle([m, H - m - 8, W - m, H - m], radius=4, fill=PRIMARY)

out = os.path.join(BASE, "og", "repo-social-preview.png")
img.save(out, "PNG", optimize=True)
print(out, os.path.getsize(out) // 1024, "KB")
