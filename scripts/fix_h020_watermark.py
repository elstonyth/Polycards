# Remove the translucent auction-site watermark ("...ation.net") from
# public/cdn/cards/h-020.webp. The text is a one-line white overlay across the
# card art just above the GARY PAYTON II nameplate.
#
# Stage 1 (--mask): build the stroke mask at native res (high-pass lift inside
#   the measured text band), dilate, and write a verification preview (mask
#   drawn red over the card, 3x zoom). LOOK at it before inpainting.
# Stage 2 (--apply): run iopaint/LaMa (cached big-lama.pt, cpu) on the flattened
#   RGB, recombine with the ORIGINAL alpha untouched, re-encode webp q92, and
#   write a before/after preview. The original bytes are kept at
#   docs/research/cardmark/h-020.orig.webp (git also has them at HEAD).
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageFilter

SRC = "public/cdn/cards/h-020.webp"
OUT = "docs/research/cardmark"
WORK = os.path.join(OUT, "iopaint")
# The text line, measured at 6x on h020_rows.png (native 216x328): rows 229-248,
# x 20-170 ("ne...ration.net"). Threshold masks fail here — the snakeskin pattern
# is white-dots-on-red, the same signature as white text — so mask the whole text
# rectangle and let LaMa rebuild the repeating pattern + the two shin crossings.
RECT = (16, 227, 176, 250)  # l, t, r, b — measured rows/cols + 2px safety

os.makedirs(OUT, exist_ok=True)


def build_mask(im):
    m = Image.new("L", im.size, 0)
    d = np.zeros((im.height, im.width), dtype=np.uint8)
    l, t, r, b = RECT
    d[t:b, l:r] = 255
    m = Image.fromarray(d)
    return m


def preview(im, mask, name):
    base = im.convert("RGB")
    over = np.asarray(base).copy()
    mm = np.asarray(mask) > 0
    over[mm] = [255, 40, 40]
    prev = Image.fromarray(over)
    z = 3
    H = prev.height
    y0, y1 = int(H * 0.62), int(H * 0.88)
    crop = prev.crop((0, y0, prev.width, y1))
    crop = crop.resize((crop.width * z, crop.height * z), Image.LANCZOS)
    crop.save(f"{OUT}/{name}")


def main():
    im = Image.open(SRC).convert("RGBA")
    mask = build_mask(im)

    if "--mask" in sys.argv:
        mask.save(f"{OUT}/h020_mask.png")
        preview(im, mask, "h020_mask_preview.png")
        print("mask candidates px:", int((np.asarray(mask) > 0).sum()))
        print(f"wrote {OUT}/h020_mask_preview.png — verify before --apply")
        return

    if "--apply" in sys.argv:
        shutil.rmtree(WORK, ignore_errors=True)
        os.makedirs(os.path.join(WORK, "img"))
        os.makedirs(os.path.join(WORK, "msk"))
        os.makedirs(os.path.join(WORK, "out"), exist_ok=True)
        rgb = im.convert("RGB")
        rgb.save(os.path.join(WORK, "img", "h-020.png"))
        mask.save(os.path.join(WORK, "msk", "h-020.png"))
        r = subprocess.run(
            [r"C:/Users/PC/iopaint-venv/Scripts/iopaint.exe", "run",
             "--model=lama", "--device=cpu",
             f"--image={WORK}/img", f"--mask={WORK}/msk", f"--output={WORK}/out"],
            capture_output=True, text=True, timeout=600)
        print(r.stdout[-2000:], r.stderr[-2000:])
        res = Image.open(os.path.join(WORK, "out", "h-020.png")).convert("RGB")
        assert res.size == im.size, f"size changed: {res.size}"
        merged = res.copy()
        merged.putalpha(im.getchannel("A"))
        if not os.path.exists(f"{OUT}/h-020.orig.webp"):
            shutil.copyfile(SRC, f"{OUT}/h-020.orig.webp")
        merged.save(SRC, "WEBP", quality=92)
        preview(merged, Image.new("L", im.size, 0), "h020_after_preview.png")
        print("applied; alpha preserved:",
              np.array_equal(np.asarray(Image.open(SRC).convert("RGBA").getchannel("A")),
                             np.asarray(im.getchannel("A"))))
        return

    print("usage: --mask | --apply")


if __name__ == "__main__":
    main()
