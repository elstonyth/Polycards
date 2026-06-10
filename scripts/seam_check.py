# Analyze the bottom-strip frames captured by verify-anim-seam.mjs: compute per-pixel motion
# (max-min across the playing frames) and render it over frame 0, so a frozen-rectangle SEAM (a sharp
# zero-motion rect where the placard/url was frozen, surrounded by MOVING base pixels) is obvious.
# Clean = motion is uniform sub-threshold noise everywhere (no rect stands out). Usage:
#   <venv>/python seam_check.py nba-legend
import sys
import glob
import numpy as np
from PIL import Image

OUT = "docs/research/packdetail"
for slug in sys.argv[1:]:
    files = sorted(glob.glob(f"{OUT}/seam_{slug}_*.png"))
    if len(files) < 3:
        print(f"{slug}: need frames (found {len(files)})")
        continue
    imgs = [np.asarray(Image.open(f).convert("RGB"), dtype=np.float32) for f in files]
    h = min(i.shape[0] for i in imgs)
    w = min(i.shape[1] for i in imgs)
    arr = np.stack([i[:h, :w] for i in imgs], 0)
    motion = (arr.max(0) - arr.min(0)).max(2)          # peak-to-peak per pixel
    # overlay: dim frame-0, paint motion in red
    ov = imgs[0][:h, :w] * 0.5
    ov[..., 0] = np.clip(ov[..., 0] + motion * 3.0, 0, 255)
    Image.fromarray(ov.astype(np.uint8)).save(f"{OUT}/seammap_{slug}.png")
    Image.fromarray(np.clip(motion * 4, 0, 255).astype(np.uint8)).save(f"{OUT}/seammap_{slug}_amp.png")
    # report motion in 5 vertical bands (the placard/url sit in this strip)
    print(f"{slug}: {len(files)}f {w}x{h}  (strip is y68–98% of machine)")
    for k in range(6):
        y0, y1 = int(k / 6 * h), int((k + 1) / 6 * h)
        b = motion[y0:y1]
        print(f"  band{k}  mean={b.mean():5.1f} peak={b.max():4.0f} moving%={float((b>14).mean())*100:5.1f}")
