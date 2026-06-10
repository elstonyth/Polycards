# 2D motion grid — localizes WHERE pixels move across animation frames (text heatmap).
# Distinguishes real object-motion (a few cells with high tail) from global webp compression
# noise (uniform low motion everywhere, incl. empty background). Usage:
#   <venv>/python probe_grid.py legend-pack-1dpaec modern-grails-noafw0
# Prints a 12-row x 10-col grid of "% pixels moving >12 levels" per cell. A cell over a STATIC
# placard reads ~the same as an empty-background cell (= noise floor) => safe to freeze.
import sys
import os
import numpy as np
import pillow_avif  # noqa: F401
from PIL import Image

DIR = "public/images/claw"
ROWS, COLS = 12, 10


def src_for(base):
    for c in (f"{DIR}/{base}-machine.avif", f"{DIR}/{base}-machine-src.webp"):
        if os.path.exists(c):
            return c
    return None


for base in sys.argv[1:]:
    p = src_for(base)
    if not p:
        print(f"{base}: NO source")
        continue
    im = Image.open(p)
    n = getattr(im, "n_frames", 1)
    if n < 2:
        print(f"{base}: STATIC ({n}f)")
        continue
    mx = mn = None
    for i in range(n):
        im.seek(i)
        a = np.asarray(im.convert("RGB"), dtype=np.float32)
        if mx is None:
            mx, mn = a.copy(), a.copy()
        else:
            np.maximum(mx, a, out=mx)
            np.minimum(mn, a, out=mn)
    motion = (mx - mn).max(2)
    H, W = motion.shape
    print(f"\n{base}: {n}f {W}x{H}  src={os.path.basename(p)}   (cell = % pixels moving >12)")
    print("      " + "".join(f"c{c:<4d}" for c in range(COLS)))
    for r in range(ROWS):
        y0, y1 = int(r / ROWS * H), int((r + 1) / ROWS * H)
        cells = []
        for c in range(COLS):
            x0, x1 = int(c / COLS * W), int((c + 1) / COLS * W)
            frac = float((motion[y0:y1, x0:x1] > 12).mean()) * 100
            cells.append(frac)
        rowlbl = f"r{r:<2d}{int(r/ROWS*100):>3d}%"
        print(rowlbl + " " + "".join(f"{v:5.0f}" for v in cells))
