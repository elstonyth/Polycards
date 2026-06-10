# Side-by-side ORIGINAL (phygitals) vs CURRENT (pokenic) placard at native pixels (NEAREST scale, no
# interpolation blur) so size/position/crispness can be judged truthfully. Usage:
#   <venv>/python compare_placard.py mythic-pack 0.385 0.515 0.755 0.835
# reads docs/research/packdetail/_orig/{base}.webp and public/images/claw/{base}-machine.webp
import sys
from PIL import Image, ImageDraw

DIR = "public/images/claw"
ORIG = "docs/research/packdetail/_orig"
OUT = "docs/research/packdetail"

base = sys.argv[1]
fx0, fx1, fy0, fy1 = (float(v) for v in sys.argv[2:6])


def cropz(path):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    c = im.crop((int(fx0 * W), int(fy0 * H), int(fx1 * W), int(fy1 * H)))
    s = max(1, int(560 / c.width))
    return c.resize((c.width * s, c.height * s), Image.NEAREST), s


a, s = cropz(f"{ORIG}/{base}.webp")
b, _ = cropz(f"{DIR}/{base}-machine.webp")
gap = 16
sheet = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height) + 20), (35, 35, 40))
sheet.paste(a, (0, 20))
sheet.paste(b, (a.width + gap, 20))
d = ImageDraw.Draw(sheet)
d.text((4, 4), f"ORIG (phygitals)  x{s}", fill=(120, 220, 120))
d.text((a.width + gap + 4, 4), "NEW (pokenic)", fill=(255, 220, 80))
sheet.save(f"{OUT}/compare_{base}.png")
print(f"compare_{base}.png  origsize {a.width}x{a.height} (x{s})")
