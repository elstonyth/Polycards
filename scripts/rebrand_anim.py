# Animated rebrand: for each base with an animated source, freeze the STATIC rebranded zones from
# the composed -machine.webp onto EVERY frame, preserving each frame's duration, and re-encode an
# animated avif {base}-anim.avif. Frozen zones = (1) the top banner band (rebranded "pokenic"
# wordmark — proven static) + (2) the bottom edit-mask (where the baked "phygitals" placard/url were
# BLANKED by rebrand_bottom.mjs — also static). The brand placard/url TEXT is NOT in the asset; the
# component overlays it as crisp DOM text. Freezing only these provably-static masked pixels is
# seam-proof (you can't freeze a moving pixel you didn't touch).
import sys
import os
import pillow_avif  # noqa: F401
from PIL import Image, ImageDraw

BAND = 0.27  # top fraction = static banner zone (claw motion starts below)
MASKDIR = "docs/research/packdetail/bottom-mask"
bases = sys.argv[1:]
for base in bases:
    srcp = f"public/images/claw/{base}-machine.avif"
    rebp = f"public/images/claw/{base}-machine.webp"
    if not os.path.exists(srcp):
        alt = f"public/images/claw/{base}-machine-src.webp"  # animated original backup (webp)
        if os.path.exists(alt):
            srcp = alt
        else:
            print(f"{base}: SKIP (no animated source)")
            continue
    src = Image.open(srcp)
    if getattr(src, "n_frames", 1) < 2:
        print(f"{base}: SKIP (source is static, {getattr(src, 'n_frames', 1)}f)")
        continue
    reb = Image.open(rebp).convert("RGB")
    W, H = src.size
    if reb.size != (W, H):
        reb = reb.resize((W, H))

    # combined static overlay mask: top banner band (solid) + bottom edit-mask (blanked placard/url)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rectangle([0, 0, W, int(BAND * H)], fill=255)
    bm_path = f"{MASKDIR}/{base}.png"
    if os.path.exists(bm_path):
        bm = Image.open(bm_path).convert("L")
        if bm.size != (W, H):
            bm = bm.resize((W, H))
        mask.paste(255, (0, 0), bm)   # OR the bottom edit-mask into the static mask

    frames, durs = [], []
    for i in range(src.n_frames):
        src.seek(i)
        durs.append(src.info.get("duration", 40))
        fr = src.convert("RGB").copy()
        fr.paste(reb, (0, 0), mask)   # freeze banner band + blanked bottom from the still
        frames.append(fr)
    out = f"public/images/claw/{base}-anim.avif"
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durs, loop=0, quality=92)
    print(f"{base}: {len(frames)}f {round(os.path.getsize(out) / 1024)}KB durs={sorted(set(durs))}")
