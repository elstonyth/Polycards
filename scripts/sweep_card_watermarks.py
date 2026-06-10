# Read-only sweep for translucent card-face watermarks (auction-site overlays).
# Per card: render at the pack-open reveal width (343px @1440 viewport), split into
# top/bottom halves laid SIDE BY SIDE (wide-short images survive the Read tool's
# display downscale), composited on the reveal's near-black stage.
import glob
import os

from PIL import Image, ImageDraw

OUT = "docs/research/cardmark"
os.makedirs(OUT, exist_ok=True)

REVEAL_W = 343
GAP = 10
BG = (17, 17, 17)


def main():
    files = sorted(glob.glob("public/cdn/cards/*.webp"))
    for f in files:
        base = os.path.basename(f).replace(".webp", "")
        im = Image.open(f).convert("RGBA")
        s = REVEAL_W / im.width
        im = im.resize((REVEAL_W, int(im.height * s)), Image.LANCZOS)
        flat = Image.new("RGBA", im.size, BG + (255,))
        flat.paste(im, (0, 0), im)
        flat = flat.convert("RGB")
        mid = flat.height // 2
        top, bot = flat.crop((0, 0, flat.width, mid)), flat.crop((0, mid, flat.width, flat.height))
        h = max(top.height, bot.height) + 16
        sheet = Image.new("RGB", (REVEAL_W * 2 + GAP, h), BG)
        sheet.paste(top, (0, 16))
        sheet.paste(bot, (REVEAL_W + GAP, 16))
        d = ImageDraw.Draw(sheet)
        d.text((4, 2), f"{base}  (top | bottom)", fill=(255, 210, 60))
        sheet.save(f"{OUT}/half_{base}.png")
    print(f"wrote {len(files)} half_*.png")


if __name__ == "__main__":
    main()
