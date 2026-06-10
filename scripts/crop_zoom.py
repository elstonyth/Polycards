# Crop a fractional region of a machine still, enlarge it, and overlay a fine labeled grid so
# small placard/url text coordinates can be read exactly. Usage:
#   <venv>/python crop_zoom.py mythic-pack 0.30 0.55 0.68 0.92
# args: base x0 x1 y0 y1   (fractions of full image)
# writes docs/research/packdetail/zoom_{base}.png ; grid labels are GLOBAL % of the full image.
import sys
from PIL import Image, ImageDraw

DIR = "public/images/claw"
OUT = "docs/research/packdetail"

base = sys.argv[1]
fx0, fx1, fy0, fy1 = (float(v) for v in sys.argv[2:6])
im = Image.open(f"{DIR}/{base}-machine.webp").convert("RGB")
W, H = im.size
x0, x1, y0, y1 = int(fx0 * W), int(fx1 * W), int(fy0 * H), int(fy1 * H)
crop = im.crop((x0, y0, x1, y1))
cw, ch = crop.size
scale = max(1, int(1100 / cw))
crop = crop.resize((cw * scale, ch * scale), Image.NEAREST)
CW, CH = crop.size
d = ImageDraw.Draw(crop, "RGBA")
# vertical lines at every 1% of GLOBAL width that falls in the crop
gx = fx0
k = int(fx0 * 100)
for k in range(int(fx0 * 100), int(fx1 * 100) + 1):
    gx = k / 100 * W
    if x0 <= gx <= x1:
        px = int((gx - x0) / (x1 - x0) * CW)
        major = (k % 5 == 0)
        d.line([(px, 0), (px, CH)], fill=(255, 0, 80, 200) if major else (0, 170, 255, 120), width=2 if major else 1)
        if major:
            d.text((px + 1, 1), f"{k}", fill=(255, 255, 0, 255))
for k in range(int(fy0 * 100), int(fy1 * 100) + 1):
    gy = k / 100 * H
    if y0 <= gy <= y1:
        py = int((gy - y0) / (y1 - y0) * CH)
        major = (k % 5 == 0)
        d.line([(0, py), (CW, py)], fill=(255, 0, 80, 200) if major else (0, 170, 255, 120), width=2 if major else 1)
        if major:
            d.text((1, py + 1), f"{k}", fill=(255, 255, 0, 255))
crop.save(f"{OUT}/zoom_{base}.png")
print(f"{base}: crop ({x0},{y0})-({x1},{y1}) -> {CW}x{CH} (x{scale})")
