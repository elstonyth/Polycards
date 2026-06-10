# Contact sheet: crop the SAME region from many machine stills and stack them labeled, so all
# placards/urls can be checked in a single Read (framing-drift check before rebrand; "does it say
# pokenic" check after). Usage:
#   <venv>/python contact_sheet.py out=pk_placards 0.36 0.52 0.745 0.835  mythic-pack legend-pack elite-pack ...
# args: out=NAME x0 x1 y0 y1  base1 base2 ...   -> docs/research/packdetail/cs_{NAME}.png
import sys
from PIL import Image, ImageDraw

DIR = "public/images/claw"
OUT = "docs/research/packdetail"

name = sys.argv[1].split("=", 1)[1]
fx0, fx1, fy0, fy1 = (float(v) for v in sys.argv[2:6])
bases = sys.argv[6:]

tiles = []
labelW = 150
for base in bases:
    try:
        im = Image.open(f"{DIR}/{base}-machine.webp").convert("RGB")
    except FileNotFoundError:
        print(f"{base}: missing")
        continue
    W, H = im.size
    crop = im.crop((int(fx0 * W), int(fy0 * H), int(fx1 * W), int(fy1 * H)))
    cw, ch = crop.size
    scale = max(1, int(720 / cw))
    crop = crop.resize((cw * scale, ch * scale), Image.NEAREST)   # NEAREST = true pixels, no upscale blur
    tiles.append((base, crop))

if not tiles:
    print("no tiles")
    sys.exit(1)

tw = max(t[1].width for t in tiles)
th = sum(t[1].height for t in tiles) + 4 * len(tiles)
sheet = Image.new("RGB", (labelW + tw, th), (40, 40, 46))
d = ImageDraw.Draw(sheet)
y = 0
for base, crop in tiles:
    sheet.paste(crop, (labelW, y))
    d.text((6, y + crop.height // 2 - 4), base, fill=(255, 255, 0))
    d.line([(0, y + crop.height + 2), (labelW + tw, y + crop.height + 2)], fill=(90, 90, 100))
    y += crop.height + 4
sheet.save(f"{OUT}/cs_{name}.png")
print(f"cs_{name}.png  {len(tiles)} tiles  region x[{fx0},{fx1}] y[{fy0},{fy1}]")
