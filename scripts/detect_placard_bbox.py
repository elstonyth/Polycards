# Robust placard-text detection + visual grid confirmation.
#  * LABEL-CONSTRAINED: a pixel is "text" only if dark AND on/near the bright label (drops basketball
#    shadow, box seams, background).
#  * WIDEST-RUN: the placard text is one wide solid block; thin contaminating strips are rejected by
#    taking the widest gap-merged run of text columns.
#  * VERIFY: draws the detected bbox (red) AND a fine 0.01 coordinate grid onto a zoomed crop, so the
#    number can be cross-checked by eye — never trust a raw number alone.
#   python detect_placard_bbox.py <orig|cur> [base ...]
import subprocess, io, sys
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

def load_git(rev, path):
    data = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True).stdout
    return Image.open(io.BytesIO(data)).convert("RGB")

def label_text_bbox(im, region, darkthr=100, brightthr=195):
    W, H = im.size
    x0, y0, x1, y1 = int(region[0]*W), int(region[1]*H), int(region[2]*W), int(region[3]*H)
    sub = np.asarray(im.crop((x0, y0, x1, y1))).astype(int)
    mn = sub.min(2); lum = sub.sum(2) / 3
    bright = ((mn > brightthr).astype(np.uint8)) * 255
    near = np.asarray(Image.fromarray(bright).filter(ImageFilter.MaxFilter(11))) > 0
    text = (lum < darkthr) & near
    cols = text.sum(0)
    mask = cols >= 2
    runs = []
    i = 0
    while i < len(mask):
        if mask[i]:
            j = i
            while j < len(mask) and mask[j]:
                j += 1
            runs.append([i, j-1]); i = j
        else:
            i += 1
    if not runs:
        return None
    G = int(0.014 * W)  # merge runs separated by <= ~14px (inter-word/letter gaps)
    merged = [runs[0][:]]
    for s, e in runs[1:]:
        if s - merged[-1][1] <= G:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    s, e = max(merged, key=lambda r: r[1]-r[0])  # widest block = the real text
    rows = text[:, s:e+1].sum(1)
    ys = np.where(rows >= 2)[0]
    if not len(ys):
        return None
    return dict(left=round((x0+s)/W, 4), right=round((x0+e)/W, 4),
               top=round((y0+ys.min())/H, 4), bot=round((y0+ys.max())/H, 4))

def viz(im, region, bb, path, scale=6):
    W, H = im.size
    x0, y0, x1, y1 = int(region[0]*W), int(region[1]*H), int(region[2]*W), int(region[3]*H)
    crop = im.crop((x0, y0, x1, y1)).resize(((x1-x0)*scale, (y1-y0)*scale), Image.NEAREST)
    d = ImageDraw.Draw(crop)
    fx = round(region[0], 2)
    while fx <= region[2] + 1e-9:
        px = int((fx*W - x0)*scale)
        major = abs((fx/0.02) - round(fx/0.02)) < 1e-6
        d.line([(px, 0), (px, crop.height)], fill=(255, 60, 60) if major else (255, 150, 150))
        if major:
            d.text((px+1, 1), f"{fx:.2f}", fill=(255, 90, 90))
        fx = round(fx + 0.01, 2)
    if bb:
        d.rectangle([(bb['left']*W-x0)*scale, (bb['top']*H-y0)*scale,
                     (bb['right']*W-x0)*scale, (bb['bot']*H-y0)*scale], outline=(0, 220, 0), width=2)
        d.text((2, crop.height-12), f"L={bb['left']:.3f} T={bb['top']:.3f}", fill=(0, 255, 0))
    crop.save(path)

REG = {  # generous region; widest-run + label-mask isolate the text within it
    "legend-pack-1dpaec":     (0.33, 0.782, 0.52, 0.823),
    "modern-grails-noafw0":   (0.33, 0.779, 0.52, 0.822),
    "starter-riftbound-pack": (0.34, 0.749, 0.54, 0.795),
}
mode = sys.argv[1] if len(sys.argv) > 1 else "orig"
bases = sys.argv[2:] or list(REG)
for base in bases:
    path = f"public/images/claw/{base}-machine.webp"
    im = load_git("8543b8d", path) if mode == "orig" else Image.open(path).convert("RGB")
    bb = label_text_bbox(im, REG[base])
    viz(im, REG[base], bb, f"docs/research/packdetail/bbox_{mode}_{base}.png")
    print(f"{base} [{mode}]: {bb}")
