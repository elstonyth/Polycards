"""Checks for stamp-logo.py. Run with any Python that has Pillow (Hermes's own
does): python -m unittest discover -s tools/desk-reports/hooks"""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stamp_logo", HERE / "stamp-logo.py")
stamp_logo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stamp_logo)


def payload(path, tool="image_generate", success=True):
    result = json.dumps({"success": success, "image": str(path)})
    return {"hook_event_name": "post_tool_call", "tool_name": tool, "extra": {"result": result}}


class StampLogo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.cache = self.home / "cache" / "images"
        self.cache.mkdir(parents=True)
        os.environ["HERMES_HOME"] = str(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def image(self, name, colour, size=(1024, 1536), folder=None):
        path = (folder or self.cache) / name
        Image.new("RGB", size, colour).save(path)
        return path

    def logo_pixels(self, path):
        """Mean RGB inside the logo box, at its widest point."""
        with Image.open(path) as im:
            w = im.width
            m = round(w * 0.045)
            box = (m, m, m + round(w * 0.2), m + round(w * 0.2 * 97 / 360))
            return im.convert("RGB").crop(box).resize((1, 1), Image.BOX).getpixel((0, 0))

    def test_stamps_a_white_wordmark_on_a_dark_image(self):
        path = self.image("dark.png", (10, 10, 10))
        stamp_logo.run(payload(path))
        self.assertGreater(sum(self.logo_pixels(path)), 3 * 40)
        with Image.open(path) as im:
            self.assertEqual(im.size, (1024, 1536))
            self.assertEqual(im.info.get(stamp_logo.MARK_KEY), "1")

    def test_stamps_a_dark_wordmark_on_a_light_image(self):
        path = self.image("light.png", (245, 245, 240))
        stamp_logo.run(payload(path))
        self.assertLess(sum(self.logo_pixels(path)), 3 * 225)

    def test_moves_to_the_calmest_corner_when_the_top_left_is_busy(self):
        path = self.cache / "busy.png"
        im = Image.new("RGB", (1024, 1024), (10, 10, 10))
        # Fine white stripes over the whole top band: like AI-drawn text.
        for x in range(0, 1024, 6):
            im.paste((240, 240, 240), (x, 0, x + 3, 300))
        im.save(path)
        stamp_logo.run(payload(path))
        with Image.open(path) as out:
            w = out.width
            m = round(w * 0.045)
            lw, lh = round(w * 0.2), round(w * 0.2 * 97 / 360)
            box = (m, w - m - lh, m + lw, w - m)  # bottom-left
            spot = out.convert("RGB").crop(box).resize((1, 1), Image.BOX).getpixel((0, 0))
        self.assertGreater(sum(spot), 3 * 40)

    def test_stamps_once(self):
        path = self.image("once.png", (10, 10, 10))
        stamp_logo.run(payload(path))
        first = path.read_bytes()
        stamp_logo.run(payload(path))
        self.assertEqual(path.read_bytes(), first)

    def test_keeps_a_jpeg_a_jpeg(self):
        path = self.cache / "photo.jpg"
        Image.new("RGB", (1536, 1024), (20, 20, 30)).save(path, "JPEG")
        stamp_logo.run(payload(path))
        with Image.open(path) as im:
            self.assertEqual(im.format, "JPEG")
            self.assertEqual(im.size, (1536, 1024))

    def test_touches_nothing_outside_the_image_cache(self):
        outside = self.image("outside.png", (10, 10, 10), folder=self.home)
        before = outside.read_bytes()
        stamp_logo.run(payload(outside))
        self.assertEqual(outside.read_bytes(), before)

    def test_ignores_other_tools_and_failed_generations(self):
        path = self.image("other.png", (10, 10, 10))
        before = path.read_bytes()
        stamp_logo.run(payload(path, tool="vision_analyze"))
        stamp_logo.run(payload(path, success=False))
        self.assertEqual(path.read_bytes(), before)

    def test_a_broken_file_never_raises(self):
        path = self.cache / "broken.png"
        path.write_bytes(b"not an image")
        with redirect_stderr(io.StringIO()):
            stamp_logo.run(payload(path))  # logs to stderr, does not raise
        self.assertEqual(path.read_bytes(), b"not an image")


if __name__ == "__main__":
    unittest.main()
