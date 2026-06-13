// Phase 1 helper — dump stroke-row blocks per pokemon icon in the bottom text
// region, so rebrand-pokemon-icons.mjs gets TIGHT per-icon url bands (the tier
// name sits a few px above the url line; a shared band merges them).
//   node scripts/probe-icon-text.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const JOBS = [
  ['mythic-pack', 'public/images/claw/mythic-pack-icon.webp', 'dark'],
  ['legend-pack', 'public/images/claw/legend-pack-icon.webp', 'dark'],
  ['elite-pack', 'public/images/claw/elite-pack-icon.webp', 'dark'],
  ['platinum-pack', 'public/images/claw/platinum-pack-icon.webp', 'dark'],
  ['rookie-pack', 'public/images/claw/rookie-pack-icon.webp', 'dark'],
  ['trainer-pack', 'public/images/claw/trainer-pack-icon.webp', 'dark'],
  ['black-pack', 'public/images/claw/black-pack-icon.webp', 'light'],
  ['diamond-pack', 'public/images/claw/diamond-pack-icon.webp', 'light'],
  ['sealed-pack', 'docs/research/missing-tiers/sealed-pack-icon.webp', 'dark'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

for (const [name, path, dir] of JOBS) {
  const data =
    'data:image/webp;base64,' + (await readFile(path)).toString('base64');
  const out = await page.evaluate(
    async ({ data, dir }) => {
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
      const od = ctx.getImageData(0, 0, W, H).data;
      const bx0 = Math.round(0.06 * W),
        bx1 = Math.round(0.75 * W),
        by0 = Math.round(0.78 * H),
        by1 = Math.round(0.95 * H);
      const lum = [];
      for (let y = by0; y <= by1; y += 2)
        for (let x = bx0; x <= bx1; x += 2) {
          const p = (y * W + x) * 4;
          lum.push(od[p] + od[p + 1] + od[p + 2]);
        }
      lum.sort((a, b) => a - b);
      const medL = lum[lum.length >> 1];
      const TH = dir === 'dark' ? 150 : 120;
      const isHit = (s) => (dir === 'dark' ? s < medL - TH : s > medL + TH);
      const rows = [];
      for (let y = by0; y <= by1; y++) {
        let c = 0,
          lx = 1e9,
          rx = -1;
        for (let x = bx0; x <= bx1; x++) {
          const p = (y * W + x) * 4;
          if (isHit(od[p] + od[p + 1] + od[p + 2])) {
            c++;
            if (x < lx) lx = x;
            if (x > rx) rx = x;
          }
        }
        rows.push({ y, c, lx, rx });
      }
      // contiguous blocks of rows with >=3 stroke px, split on gaps > 4 rows
      const blocks = [];
      let cur = null,
        gap = 0;
      for (const r of rows) {
        if (r.c >= 3) {
          if (!cur) cur = { top: r.y, bot: r.y, lx: r.lx, rx: r.rx, max: r.c };
          else {
            cur.bot = r.y;
            cur.lx = Math.min(cur.lx, r.lx);
            cur.rx = Math.max(cur.rx, r.rx);
            cur.max = Math.max(cur.max, r.c);
          }
          gap = 0;
        } else if (cur && ++gap > 4) {
          blocks.push(cur);
          cur = null;
        }
      }
      if (cur) blocks.push(cur);
      return {
        W,
        H,
        blocks: blocks.map((b) => ({
          topPct: +((b.top / H) * 100).toFixed(2),
          botPct: +((b.bot / H) * 100).toFixed(2),
          hPx: b.bot - b.top + 1,
          leftPct: +((b.lx / W) * 100).toFixed(2),
          rightPct: +((b.rx / W) * 100).toFixed(2),
          maxRow: b.max,
        })),
      };
    },
    { data, dir },
  );
  console.log(`${name} ${out.W}x${out.H}`);
  for (const b of out.blocks) console.log('   ', JSON.stringify(b));
}
await browser.close();
