# Measure the TRUE placard position for the base-group claw machines.
# Left panel  = ORIGINAL (git 8543b8d, still has "phygitals claw." baked) — ground truth.
# Right panel = CURRENT working-tree still (our "pokenic claw." placement).
# Both cropped to the placard region with a fractional (0..1) coordinate grid so the exact
# top-left + width of the text can be read off and turned into a precise pin.
import subprocess, io, sys
from PIL import Image, ImageDraw

def load_git(rev, path):
    data = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True).stdout
    return Image.open(io.BytesIO(data)).convert("RGB")

def grid_crop(im, x0f, y0f, x1f, y1f, scale=5):
    W, H = im.size
    x0, y0, x1, y1 = int(x0f*W), int(y0f*H), int(x1f*W), int(y1f*H)
    crop = im.crop((x0, y0, x1, y1)).resize(((x1-x0)*scale, (y1-y0)*scale), Image.NEAREST)
    d = ImageDraw.Draw(crop)
    fx = round(x0f, 3)
    while fx <= x1f + 1e-9:
        px = int((fx*W - x0)*scale)
        d.line([(px, 0), (px, crop.height)], fill=(255, 40, 40))
        d.text((px+1, 1), f"{fx:.3f}", fill=(255, 80, 80))
        fx += 0.025
    fy = round(y0f, 3)
    while fy <= y1f + 1e-9:
        py = int((fy*H - y0)*scale)
        d.line([(0, py), (crop.width, py)], fill=(0, 170, 255))
        d.text((1, py+1), f"{fy:.3f}", fill=(60, 190, 255))
        fy += 0.025
    return crop

bases = sys.argv[1:] or ["legend-pack-1dpaec", "modern-grails-noafw0", "starter-riftbound-pack", "pro-soccer-pack"]
region = (0.275, 0.71, 0.585, 0.93)
for base in bases:
    path = f"public/images/claw/{base}-machine.webp"
    orig = load_git("8543b8d", path)
    cur = Image.open(path).convert("RGB")
    a = grid_crop(orig, *region)
    b = grid_crop(cur, *region)
    combo = Image.new("RGB", (a.width + b.width + 12, max(a.height, b.height)), (20, 20, 20))
    combo.paste(a, (0, 0)); combo.paste(b, (a.width + 12, 0))
    d = ImageDraw.Draw(combo)
    d.text((4, combo.height-14), "ORIGINAL (phygitals claw.)", fill=(255, 230, 120))
    d.text((a.width+16, combo.height-14), "CURRENT (pokenic claw.)", fill=(120, 255, 160))
    combo.save(f"docs/research/packdetail/measure_{base}.png")
    print(f"{base}: {orig.size}  region={region}")
print("done")
