# Measure which pixels are STATIC vs MOVING across all frames of an animated claw source.
# The banner band-paste rebrand only works on PROVABLY static regions; this gates the
# placard (body-text) rebrand before any pixel work. Usage:
#   <venv>/python static_heatmap.py mythic-pack legend-pack-1dpaec pro-soccer-pack
# Writes (per base) to docs/research/packdetail/:
#   static_{base}_amp.png      grayscale peak-to-peak motion (x4 amplified; bright = moves)
#   static_{base}_overlay.png  frame-0 dimmed, motion painted RED (where the claw etc. move)
# and prints a per-5%-vertical-band motion table so the static placard band is exact, not eyeballed.
import sys
import os
import numpy as np
import pillow_avif  # noqa: F401 — registers AVIF codec
from PIL import Image

DIR = "public/images/claw"
OUT = "docs/research/packdetail"


def src_for(base):
    for cand in (f"{DIR}/{base}-machine.avif", f"{DIR}/{base}-machine-src.webp"):
        if os.path.exists(cand):
            return cand
    return None


for base in sys.argv[1:]:
    p = src_for(base)
    if not p:
        print(f"{base}: NO animated source on disk")
        continue
    im = Image.open(p)
    n = getattr(im, "n_frames", 1)
    if n < 2:
        print(f"{base}: STATIC source ({n} frame) — {os.path.basename(p)}")
        continue
    mx = mn = first = None
    for i in range(n):
        im.seek(i)
        a = np.asarray(im.convert("RGB"), dtype=np.float32)
        if mx is None:
            mx, mn, first = a.copy(), a.copy(), a.copy()
        else:
            np.maximum(mx, a, out=mx)
            np.minimum(mn, a, out=mn)
    H, W = first.shape[:2]
    motion = (mx - mn).max(2)            # (H, W) peak-to-peak across frames, max over RGB

    Image.fromarray(np.clip(motion * 4, 0, 255).astype(np.uint8)).save(f"{OUT}/static_{base}_amp.png")
    ov = first * 0.45
    ov[..., 0] = np.clip(ov[..., 0] + motion * 3.0, 0, 255)
    Image.fromarray(ov.astype(np.uint8)).save(f"{OUT}/static_{base}_overlay.png")

    print(f"{base}: {n}f {W}x{H}  src={os.path.basename(p)}")
    for k in range(20):
        y0, y1 = int(k / 20 * H), int((k + 1) / 20 * H)
        band = motion[y0:y1]
        frac = float((band > 12).mean())      # fraction of pixels moving >12 levels
        bar = "#" * int(frac * 40)
        print(f"  y {k*5:3d}-{(k+1)*5:3d}%  mean={band.mean():5.1f}  peak={band.max():4.0f}  moving%={frac*100:5.1f}  {bar}")
