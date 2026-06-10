# Audit every claw-machine asset: for each base, the source chain (-machine.avif / -machine-src.webp
# = ORIGINAL animated source; -machine.webp = composed still; -anim.avif = rebranded output) with
# frame counts, so we can confirm the rebrand is built from the ORIGINAL ANIMATED source and flag
# anything STATIC (broken animation) or stale/orphaned.
import os
import glob
import pillow_avif  # noqa: F401
from PIL import Image

DIR = "public/images/claw"


def frames(p):
    if not os.path.exists(p):
        return None
    try:
        return getattr(Image.open(p), "n_frames", 1)
    except Exception as e:
        return f"ERR({e})"


bases = sorted({os.path.basename(f).replace("-machine.avif", "").replace("-machine-src.webp", "")
                .replace("-machine.webp", "").replace("-anim.avif", "").replace("-icon.webp", "")
                for f in glob.glob(f"{DIR}/*-machine.*") + glob.glob(f"{DIR}/*-anim.avif")})

print(f"{'base':30} {'orig.avif':>10} {'orig-src.webp':>13} {'still.webp':>10} {'ANIM.avif':>10}  source-used")
print("-" * 100)
for b in bases:
    av = frames(f"{DIR}/{b}-machine.avif")
    sw = frames(f"{DIR}/{b}-machine-src.webp")
    st = frames(f"{DIR}/{b}-machine.webp")
    an = frames(f"{DIR}/{b}-anim.avif")
    # which source rebrand_anim.py would use: -machine.avif if exists, else -machine-src.webp
    if av is not None:
        used = f"-machine.avif ({av}f)" + ("  <STATIC!>" if isinstance(av, int) and av < 2 else "")
    elif sw is not None:
        used = f"-machine-src.webp ({sw}f)" + ("  <STATIC!>" if isinstance(sw, int) and sw < 2 else "")
    else:
        used = "(none — static webp only)"
    flag = ""
    if isinstance(an, int) and an < 2:
        flag = "  <<< ANIM IS STATIC/BROKEN"
    print(f"{b:30} {str(av):>10} {str(sw):>13} {str(st):>10} {str(an):>10}  {used}{flag}")
