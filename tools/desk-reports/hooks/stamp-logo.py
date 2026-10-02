"""Hermes post_tool_call hook: puts the official Polycards wordmark on every
image a desk bot generates, before the gateway attaches it to the chat.

The desk profile's config.yaml runs this for image_generate (hooks:
post_tool_call, matcher ^image_generate$), with the profile's HERMES_HOME in
the environment. Hermes pipes the event as JSON on stdin; the tool result
names the generated file, which is edited in place. So whatever the bot does
next, the picture staff see carries the real logo, never an AI imitation of
it, and a bot cannot skip it.

Fail-open by design: a file this cannot read is left as it is and the reason
goes to stderr (Hermes logs it), so a broken image never blocks a reply.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat
from PIL.PngImagePlugin import PngInfo

# The storefront's own wordmark, shipped beside this script by install.mjs.
WORDMARK = Path(__file__).resolve().parent.parent / "brand" / "polycards-wordmark-white.png"
INK = (10, 10, 10)  # DESIGN.md ink-black
MARK_KEY = "polycards-logo"  # set on a stamped file, so it is never stamped twice


def target(event):
    """The generated file to stamp, or None. Only image_generate's own
    successful output inside this profile's image cache qualifies."""
    if event.get("tool_name") != "image_generate":
        return None
    result = (event.get("extra") or {}).get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return None
    if not isinstance(result, dict) or not result.get("success"):
        return None
    image = result.get("image")
    home = os.environ.get("HERMES_HOME")
    if not isinstance(image, str) or not home:
        return None
    path = Path(image).resolve()
    cache = (Path(home) / "cache" / "images").resolve()
    return path if cache in path.parents and path.is_file() else None


def stamp(path):
    with Image.open(path) as source:
        if source.info.get(MARK_KEY) or source.info.get("comment") == MARK_KEY.encode():
            return
        fmt = source.format
        alpha = "A" in source.getbands()
        canvas = source.convert("RGBA")
    width = canvas.width

    # A fifth of the width, never past the source file's own 360 px.
    with Image.open(WORDMARK) as mark:
        logo = mark.convert("RGBA")
    w = min(logo.width, max(120, round(width * 0.2)))
    logo = logo.resize((w, round(logo.height * w / logo.width)), Image.LANCZOS)
    margin = round(width * 0.045)
    lw, lh = logo.size
    corners = [
        (margin, margin),  # top-left: the house position
        (width - margin - lw, margin),
        (margin, canvas.height - margin - lh),
        (width - margin - lw, canvas.height - margin - lh),
    ]
    detail = [
        ImageStat.Stat(canvas.crop((x, y, x + lw, y + lh)).convert("L")).stddev[0]
        for x, y in corners
    ]
    # Top-left, unless another corner is clearly calmer: AI art that drew its
    # own text there would bury the mark.
    calmest = min(range(len(corners)), key=lambda i: detail[i])
    x, y = corners[0 if detail[0] <= detail[calmest] + 6 else calmest]
    box = (x, y, x + lw, y + lh)

    corner = ImageStat.Stat(canvas.crop(box).convert("L")).mean[0]
    if corner > 150:
        # A light corner: the same wordmark in ink-black.
        dark = Image.new("RGBA", logo.size, INK + (255,))
        dark.putalpha(logo.getchannel("A"))
        logo = dark
    else:
        # A soft ink halo keeps the white mark readable on busy art.
        pad = min(round(logo.height * 0.6), margin)
        mask = Image.new("L", (logo.width + 2 * pad, logo.height + 2 * pad), 0)
        mask.paste(logo.getchannel("A").point(lambda a: round(a * 0.55)), (pad, pad))
        halo = Image.new("RGBA", mask.size, INK + (255,))
        halo.putalpha(mask.filter(ImageFilter.GaussianBlur(logo.height * 0.35)))
        canvas.alpha_composite(halo, (x - pad, y - pad))
    canvas.alpha_composite(logo, (x, y))

    out = canvas if alpha else canvas.convert("RGB")
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=path.suffix)
    os.close(fd)
    try:
        if fmt == "PNG":
            info = PngInfo()
            info.add_text(MARK_KEY, "1")
            out.save(tmp, "PNG", pnginfo=info)
        elif fmt == "JPEG":
            out.convert("RGB").save(tmp, "JPEG", quality=95, comment=MARK_KEY)
        else:
            out.save(tmp, fmt or "PNG")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def run(event):
    path = target(event)
    if path is None:
        return
    try:
        stamp(path)
    except Exception as err:  # fail open: never block the reply
        print(f"stamp-logo: left {path.name} unstamped: {err}", file=sys.stderr)


if __name__ == "__main__":
    try:
        run(json.load(sys.stdin))
    except ValueError as err:
        print(f"stamp-logo: unreadable hook payload: {err}", file=sys.stderr)
