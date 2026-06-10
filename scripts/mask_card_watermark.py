# Thresholded high-pass map of a card face: white pixels = local brightness
# lift (translucent white overlay candidates). Sparse B/W output reads crisply
# at full display size AND is the starting point for the inpaint mask.
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = "docs/research/cardmark"
W = 750
THR = 10


def main():
    for base in sys.argv[1:]:
        im = Image.open(f"public/cdn/cards/{base}.webp").convert("RGBA")
        s = W / im.width
        im = im.resize((W, int(im.height * s)), Image.LANCZOS)
        flat = Image.new("RGBA", im.size, (17, 17, 17, 255))
        flat.paste(im, (0, 0), im)
        g = flat.convert("L")
        a = np.asarray(g, dtype=np.float32)
        blur = np.asarray(g.filter(ImageFilter.GaussianBlur(7)), dtype=np.float32)
        res = a - blur
        m = (res > THR).astype(np.uint8) * 255
        out = Image.fromarray(m).filter(ImageFilter.MedianFilter(3))
        # halves side by side to keep it wide-short
        H = out.height
        mid = H // 2
        sheet = Image.new("L", (W * 2 + 10, mid + 18), 0)
        sheet.paste(out.crop((0, 0, W, mid)), (0, 18))
        sheet.paste(out.crop((0, mid, W, H)), (W + 10, 18))
        d = ImageDraw.Draw(sheet)
        d.text((4, 2), f"{base} highpass>+{THR} (top | bottom)", fill=255)
        sheet.save(f"{OUT}/mask_{base}.png")
        print(base, "->", f"{OUT}/mask_{base}.png")


if __name__ == "__main__":
    main()
