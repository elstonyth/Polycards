// Clean rebrand of the black-pack (and diamond-pack) NEON BANNER from the
// pristine phygitals source the user supplied — the in-repo rebrand used the
// wrong font (bold, capital P) and bloomed. This: erases the glowing
// "phygitals" wordmark off the illuminated panel by smearing a clean panel
// column across the glow region, then bakes "pokenic" matching the original
// neon style (Poppins 600 lowercase, cream core + red outer glow), centered on
// the original wordmark's midpoint.
//
// Output: docs/research/brand-audit/<base>-rebrand-preview.png (review first).
// Promote to public/ + freeze onto the anim frames only after visual sign-off.
//   node scripts/rebrand-black-banner.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = 'docs/research/brand-audit';
await mkdir(OUT, { recursive: true });

// Per-banner config measured from the clean source frames.
const JOBS = [
  {
    base: 'black-pack',
    srcPng: `${OUT}/black-clean-full.png`,
    // phygitals core bbox (detected): x 564-829, y 134-212
    text: { lx: 564, rx: 829, ty: 134, by: 212 },
    // erase a bit wider/taller than the core to swallow the glow, but stay
    // below the red top rim (~y122) and above "BLACK PACK" (~y230).
    erase: { x0: 520, x1: 875, y0: 126, y1: 224 },
    cleanCol: 505, // panel column just left of the glow, used to repaint
    glow: [232, 60, 44],
    core: [255, 236, 226],
  },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
await page.addStyleTag({
  content:
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&display=swap');",
});
await page.waitForTimeout(1600);
await page.evaluate(async () => {
  await document.fonts.ready;
  if (!(await document.fonts.load('600 80px Poppins')).length)
    throw new Error('Poppins 600 failed to load');
});

for (const job of JOBS) {
  const data =
    'data:image/png;base64,' + (await readFile(job.srcPng)).toString('base64');
  const res = await page.evaluate(
    async ({ data, job }) => {
      const img = await new Promise((ok, no) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => no(new Error('load'));
        im.src = data;
      });
      const W = img.naturalWidth,
        H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H);
      const px = id.data;

      // 1) erase: for each row in the erase band, copy the clean panel column's
      //    pixel across the whole band width (kills text + glow, keeps the
      //    panel's vertical gradient).
      const { x0, x1, y0, y1 } = job.erase;
      for (let y = y0; y <= y1; y++) {
        const sp = (y * W + job.cleanCol) * 4;
        const r = px[sp],
          g = px[sp + 1],
          b = px[sp + 2];
        for (let x = x0; x <= x1; x++) {
          const dp = (y * W + x) * 4;
          px[dp] = r;
          px[dp + 1] = g;
          px[dp + 2] = b;
          px[dp + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);

      // 1b) restore the panel's red AMBIENT backglow. The flat dark erase fill
      //     replaced a center that the neon had lit, leaving a dark rectangle
      //     ("the black box"). Re-light it with a soft radial red, additively
      //     composited, centered on the sign mid so it fades out before the
      //     erase edges — no hard rectangle remains.
      {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rad = (x1 - x0) * 0.62;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        const [gr, gg, gb] = job.glow;
        g.addColorStop(0, `rgba(${gr}, ${gg}, ${gb}, 0.5)`);
        g.addColorStop(0.55, `rgba(${gr}, ${gg}, ${gb}, 0.22)`);
        g.addColorStop(1, `rgba(${gr}, ${gg}, ${gb}, 0)`);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.fillRect(x0 - 30, y0 - 30, x1 - x0 + 60, y1 - y0 + 60);
        ctx.restore();
      }

      // 2) bake "pokenic": fit font so the rendered width ≈ original wordmark
      //    width, baseline aligned to the original (descender-aware).
      const targetW = job.text.rx - job.text.lx;
      const cxMid = (job.text.lx + job.text.rx) / 2;
      // original block y134-212 incl. p/g descender; baseline ≈ by - 0.22*blockH
      const blockH = job.text.by - job.text.ty;
      const baseY = job.text.by - Math.round(0.2 * blockH);
      let fs = 86;
      const fit = () => {
        ctx.font = `600 ${fs}px Poppins, sans-serif`;
        return ctx.measureText('pokenic').width;
      };
      for (let i = 0; i < 12; i++) {
        const w = fit();
        if (Math.abs(w - targetW) < 4) break;
        fs = Math.max(20, Math.round(fs * (targetW / w)));
      }
      const drawX = cxMid - ctx.measureText('pokenic').width / 2;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      // red neon glow: several blurred passes
      ctx.shadowColor = `rgb(${job.glow[0]}, ${job.glow[1]}, ${job.glow[2]})`;
      ctx.fillStyle = `rgb(${job.glow[0]}, ${job.glow[1]}, ${job.glow[2]})`;
      for (const blur of [22, 14, 8]) {
        ctx.shadowBlur = blur;
        ctx.fillText('pokenic', drawX, baseY);
      }
      // cream core on top, slight white glow
      ctx.shadowColor = 'rgba(255,210,190,0.9)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = `rgb(${job.core[0]}, ${job.core[1]}, ${job.core[2]})`;
      ctx.fillText('pokenic', drawX, baseY);
      ctx.shadowBlur = 0;

      return {
        W,
        H,
        fs,
        baseY,
        full: cv.toDataURL('image/png'),
      };
    },
    { data, job },
  );
  await writeFile(
    `${OUT}/${job.base}-rebrand-preview.png`,
    Buffer.from(res.full.split(',')[1], 'base64'),
  );
  console.log(
    `${job.base}: fs=${res.fs} baseY=${res.baseY} -> ${OUT}/${job.base}-rebrand-preview.png`,
  );
}
await browser.close();
console.log('done — review the preview PNGs before promoting');
