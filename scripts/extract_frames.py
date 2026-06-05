# Extract every frame of an animated source to a PNG sequence (bridge for ffmpeg, which can't decode
# our animated WebP sources). Usage: <venv>/python extract_frames.py <src> <outdir>
import sys
import os
import pillow_avif  # noqa: F401
from PIL import Image

src, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
im = Image.open(src)
n = getattr(im, "n_frames", 1)
for i in range(n):
    im.seek(i)
    im.convert("RGB").save(f"{outdir}/f{i:04d}.png")
print(f"{n} frames -> {outdir}")
