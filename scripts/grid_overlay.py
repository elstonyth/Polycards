# Draw a labeled %-coordinate grid over a machine still so placard/url search-bands can be
# read off precisely (not eyeballed). Usage:
#   <venv>/python grid_overlay.py mythic-pack legend-pack-1dpaec pro-soccer-pack starter-riftbound-pack
# Reads public/images/claw/{base}-machine.webp, writes docs/research/packdetail/grid_{base}.png
import sys
import os
from PIL import Image, ImageDraw

DIR = "public/images/claw"
OUT = "docs/research/packdetail"

for base in sys.argv[1:]:
    p = f"{DIR}/{base}-machine.webp"
    if not os.path.exists(p):
        print(f"{base}: no -machine.webp")
        continue
    im = Image.open(p).convert("RGB")
    W, H = im.size
    d = ImageDraw.Draw(im, "RGBA")
    for k in range(0, 101, 5):
        x = int(k / 100 * W)
        y = int(k / 100 * H)
        major = (k % 10 == 0)
        col = (255, 0, 80, 180) if major else (0, 160, 255, 110)
        d.line([(x, 0), (x, H)], fill=col, width=2 if major else 1)
        d.line([(0, y), (W, y)], fill=col, width=2 if major else 1)
        if major:
            d.text((x + 2, 2), f"{k}", fill=(255, 255, 0, 255))
            d.text((2, y + 1), f"{k}", fill=(255, 255, 0, 255))
    im.save(f"{OUT}/grid_{base}.png")
    print(f"{base}: {W}x{H} grid written")
