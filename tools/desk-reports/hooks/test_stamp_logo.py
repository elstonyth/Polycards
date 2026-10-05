"""Checks for stamp-logo.py. Run with any Python that has Pillow (Hermes's own
does): python -m unittest discover -s tools/desk-reports/hooks"""

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stamp_logo", HERE / "stamp-logo.py")
stamp_logo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stamp_logo)


def hermes_python():
    """Hermes's own interpreter (<hermes>/tools/python-*/python.exe), or None."""
    tools = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "tools"
    found = sorted(tools.glob("python-*/python.exe")) if tools.is_dir() else []
    return found[-1] if found else None


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
            # The 4:5 size Facebook and Instagram feeds show whole.
            self.assertEqual(im.size, (1080, 1350))
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
            w, h = out.size
            m = round(w * 0.045)
            lw, lh = round(w * 0.2), round(w * 0.2 * 97 / 360)
            box = (m, h - m - lh, m + lw, h - m)  # bottom-left
            spot = out.convert("RGB").crop(box).resize((1, 1), Image.BOX).getpixel((0, 0))
        self.assertGreater(sum(spot), 3 * 40)

    def test_fits_tall_and_square_art_to_the_feed_size_keeping_its_middle(self):
        # A 2:3 portrait: red bands top and bottom, blue in the middle.
        tall = self.cache / "tall.png"
        im = Image.new("RGB", (1024, 1536), (20, 40, 200))
        im.paste((200, 20, 20), (0, 0, 1024, 100))
        im.paste((200, 20, 20), (0, 1436, 1024, 1536))
        im.save(tall)
        stamp_logo.run(payload(tall))
        with Image.open(tall) as out:
            self.assertEqual(out.size, (1080, 1350))
            # The bands are trimmed away; the middle stays.
            r, g, b = out.convert("RGB").getpixel((540, 1340))
            self.assertGreater(b, r)
        square = self.image("square.png", (10, 10, 10), size=(1254, 1254))
        stamp_logo.run(payload(square))
        with Image.open(square) as out:
            self.assertEqual(out.size, (1080, 1350))

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
            self.assertEqual(im.size, (1080, 1350))

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

    def test_runs_as_hermes_runs_it(self):
        # Hermes spawns a .py hook as [its bare interpreter, script] with the
        # event on stdin. Run it on that interpreter, not on whichever one runs
        # these tests: one with Pillow of its own would pass without the
        # dependency activation this checks.
        python = hermes_python()
        if python is None:
            self.skipTest("needs Hermes's own interpreter")
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        bare = subprocess.run(
            [str(python), "-c", "import PIL"], capture_output=True, env=env, timeout=60
        )
        if bare.returncode == 0:
            self.skipTest("this Hermes interpreter imports Pillow by itself")
        path = self.image("spawned.png", (10, 10, 10))
        done = subprocess.run(
            [str(python), str(HERE / "stamp-logo.py")],
            input=json.dumps(payload(path)),
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stderr, "")
        with Image.open(path) as im:
            self.assertEqual(im.info.get(stamp_logo.MARK_KEY), "1")

    def test_a_failed_dependency_setup_fails_open(self):
        path = self.image("no-pillow.png", (10, 10, 10))
        before = path.read_bytes()
        real = stamp_logo._pillow

        def broken():
            raise RuntimeError("dependency tree locked")

        stamp_logo._pillow = broken
        try:
            err = io.StringIO()
            with redirect_stderr(err):
                stamp_logo.run(payload(path))  # reports, does not raise
        finally:
            stamp_logo._pillow = real
        self.assertIn("left no-pillow.png unstamped: dependency tree locked", err.getvalue())
        self.assertEqual(path.read_bytes(), before)

    def test_a_broken_file_never_raises(self):
        path = self.cache / "broken.png"
        path.write_bytes(b"not an image")
        with redirect_stderr(io.StringIO()):
            stamp_logo.run(payload(path))  # logs to stderr, does not raise
        self.assertEqual(path.read_bytes(), b"not an image")


if __name__ == "__main__":
    unittest.main()
