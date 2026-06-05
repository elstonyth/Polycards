# Build the RGBA "rebrand patch" for ffmpeg overlay: the rebranded STATIC zones (banner band +
# placard/url edit-mask) from {base}-machine.webp made OPAQUE, everything else TRANSPARENT. ffmpeg
# then overlays this onto every animation frame (the static zones replace the baked "phygitals";
# the transparent rest lets the moving claw show through). Usage:
#   <venv>/python make_patch.py mythic-pack [...]
import sys
import os
from PIL import Image, ImageDraw

DIR = "public/images/claw"
MASKDIR = "docs/research/packdetail/bottom-mask"
OUT = "docs/research/packdetail/_patch"
BAND = 0.27   # top fraction = static banner zone

os.makedirs(OUT, exist_ok=True)
for base in sys.argv[1:]:
    reb = Image.open(f"{DIR}/{base}-machine.webp").convert("RGB")
    W, H = reb.size
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rectangle([0, 0, W, int(BAND * H)], fill=255)   # banner band
    bm = f"{MASKDIR}/{base}.png"
    if os.path.exists(bm):
        b = Image.open(bm).convert("L")
        if b.size != (W, H):
            b = b.resize((W, H))
        mask.paste(255, (0, 0), b)                                       # OR the placard/url edit-mask
    patch = reb.convert("RGBA")
    patch.putalpha(mask)
    patch.save(f"{OUT}/{base}.png")
    print(f"{base}: patch {W}x{H}  opaque_px={int(sum(mask.point(lambda v: 1 if v else 0).getdata()))}")
