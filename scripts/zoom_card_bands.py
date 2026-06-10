# Band zooms for watermark suspects: card upscaled to 750px wide (~4K reveal
# render scale), cut into 4 horizontal bands; sheets pair two bands stacked.
# For cards in RESIDUAL, also emit a high-pass-boosted sheet per band pair —
# translucent text overlays pop hard in the residual even when faint.
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = "docs/research/cardmark"
W = 750
SUSPECTS = sys.argv[1:] or ["h-020", "h-002", "h-005", "h-011", "h-015", "h-016", "h-019"]
RESIDUAL = {"h-020", "h-002"}
BG = (17, 17, 17)


def residual(band):
    g = band.convert("L")
    blur = g.filter(ImageFilter.GaussianBlur(6))
    a = np.asarray(g, dtype=np.float32) - np.asarray(blur, dtype=np.float32)
    r = np.clip(a * 4 + 128, 0, 255).astype(np.uint8)
    return Image.fromarray(r).convert("RGB")


def main():
    for base in SUSPECTS:
        im = Image.open(f"public/cdn/cards/{base}.webp").convert("RGBA")
        s = W / im.width
        im = im.resize((W, int(im.height * s)), Image.LANCZOS)
        flat = Image.new("RGBA", im.size, BG + (255,))
        flat.paste(im, (0, 0), im)
        flat = flat.convert("RGB")
        H = flat.height
        bands = [flat.crop((0, int(H * i / 4), W, int(H * (i + 1) / 4))) for i in range(4)]
        for sheet_i, (b1, b2) in enumerate([(0, 1), (2, 3)]):
            for kind in (["orig", "res"] if base in RESIDUAL else ["orig"]):
                t = bands[b1] if kind == "orig" else residual(bands[b1])
                b = bands[b2] if kind == "orig" else residual(bands[b2])
                sheet = Image.new("RGB", (W, t.height + b.height + 20), BG)
                sheet.paste(t, (0, 16))
                sheet.paste(b, (0, t.height + 20))
                d = ImageDraw.Draw(sheet)
                d.text((4, 2), f"{base} bands {b1+1}+{b2+1} ({kind})", fill=(255, 210, 60))
                sheet.save(f"{OUT}/zoom_{base}_{sheet_i+1}_{kind}.png")
        print(base, "->", "2 sheets" + (" + residuals" if base in RESIDUAL else ""))


if __name__ == "__main__":
    main()
