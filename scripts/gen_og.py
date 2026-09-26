#!/usr/bin/env python3
"""Generate site/og.png — the 1200x630 social card.

Run manually (not part of the npm build chain, so Windows builds never need
Python):  python3 scripts/gen_og.py
The PNG is committed; build.mjs merely copies it into dist/.
"""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1200, 630
BG = (33, 29, 26)
OK = (184, 107, 75)
BLUE = (117, 100, 168)
CRIT = (181, 92, 85)
FG = (245, 239, 229)
FG3 = (180, 169, 156)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img, "RGBA")

# faint grid
for x in range(0, W, 56):
    d.line([(x, 0), (x, H)], fill=(255, 255, 255, 6), width=1)
for y in range(0, H, 56):
    d.line([(0, y), (W, y)], fill=(255, 255, 255, 6), width=1)

# glow orbs
for cx, cy, r, col in [(-60, -40, 300, OK), (W + 40, 180, 340, BLUE)]:
    for i in range(r, 0, -6):
        a = int(14 * i / r)
        d.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(col[0], col[1], col[2], a))

F = "/usr/share/fonts/truetype/dejavu/"
f_logo = ImageFont.truetype(F + "DejaVuSans-Bold.ttf", 40)
f_h1 = ImageFont.truetype(F + "DejaVuSerif-Bold.ttf", 56)
f_mono = ImageFont.truetype(F + "DejaVuSansMono.ttf", 24)
f_small = ImageFont.truetype(F + "DejaVuSansMono.ttf", 21)

# logo mark: three rounded bars
lx, ly = 70, 64
d.rounded_rectangle([lx, ly, lx + 64, ly + 64], radius=14, fill=(26, 23, 20))
for i, wdt in enumerate((40, 26, 33)):
    y = ly + 14 + i * 14
    d.rounded_rectangle([lx + 12, y, lx + 12 + wdt, y + 6], radius=3, fill=OK)
d.text((lx + 82, ly + 10), "PrefixAudit", font=f_logo, fill=FG)

# headline
d.text((70, 210), "Your prompt cache is", font=f_h1, fill=FG)
d.text((70, 284), "probably broken.", font=f_h1, fill=OK)
d.text((70, 358), "Here's the line doing it.", font=f_h1, fill=FG)

# byte-flow strip: stable bytes, one volatile, then dead cache
bx, by = 70, 470
for i in range(24):
    x = bx + i * 30
    if i == 7:
        d.rounded_rectangle([x, by, x + 22, by + 40], radius=5, fill=CRIT)
    elif i > 7:
        d.rounded_rectangle([x, by, x + 22, by + 40], radius=5, outline=(90, 80, 70), width=2)
    else:
        d.rounded_rectangle([x, by, x + 22, by + 40], radius=5, fill=(58, 50, 44))
d.text((bx, by + 54), "cached prefix", font=f_small, fill=FG3)
d.text((bx + 7 * 30 - 8, by + 54), "first changed byte", font=f_small, fill=CRIT)

# footer
d.text((70, 576), "14 static rules  ·  zero dependencies  ·  runs in your browser", font=f_mono, fill=FG3)

out = os.path.join(ROOT, "site", "og.png")
img.save(out, "PNG")
print("wrote", out, os.path.getsize(out), "bytes")
