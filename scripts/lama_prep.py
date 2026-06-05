# Step 1 of the LaMa re-brand: for each phygitals machine, write the clean source as
# PNG (LaMa input) and a precise wordmark mask (white=erase) via black-hat/top-hat
# local-contrast detection, confined to the wordmark band so it never hits the pack name.
import os
import sys
import numpy as np
import pillow_avif  # noqa: F401 — registers AVIF codec in Pillow
from PIL import Image
import cv2
from lama_config import JOBS, DIR, LAMA_IN, LAMA_MASK, LAMA_OUT

ONLY = set(sys.argv[1:])   # optional: process only the named bases (re-derive one machine)

for d in (LAMA_IN, LAMA_MASK, LAMA_OUT):
    os.makedirs(d, exist_ok=True)

for base, cfg in JOBS.items():
    if ONLY and base not in ONLY:
        continue
    rgb = np.array(Image.open(f"{DIR}/{cfg['src']}").convert("RGB"))
    H, W = rgb.shape[:2]
    Image.fromarray(rgb).save(f"{LAMA_IN}/{base}.png")

    x0, x1 = int(cfg["band"][0] * W), int(cfg["band"][1] * W)
    y0, y1 = int(cfg["band"][2] * H), int(cfg["band"][3] * H)
    # UNIVERSAL detection: the wordmark differs from the banner background in colour,
    # whatever its hue (red/white/purple/dark). Mask = pixels far (RGB distance) from
    # the band's MEDIAN colour (= the banner background, the majority of pixels).
    sub = rgb[y0:y1, x0:x1].astype(np.float32)
    med = np.median(sub.reshape(-1, 3), axis=0)
    dist = np.sqrt(((sub - med) ** 2).sum(axis=2))
    mb = (dist > cfg.get("thresh", 55)).astype(np.uint8) * 255
    mask = np.zeros((H, W), np.uint8)
    mask[y0:y1, x0:x1] = mb
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=cfg.get("dilate", 1))
    Image.fromarray(mask).save(f"{LAMA_MASK}/{base}.png")
    print(f"{base}: {W}x{H} mask_px={int((mask>0).sum())}")

print(f"\nprepared {len(JOBS)} images + masks")
