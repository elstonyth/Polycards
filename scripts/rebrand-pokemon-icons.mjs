// Task E v2 Phase 1 — pack ICON rebrand. Machines were rebranded in the earlier
// waves (audit crops confirm "pokenic claw."), but every pokemon pack ICON still
// carries "www.phygitals.com" + the phygitals P logomark sticker. This pass,
// per icon zone: detect the ink strokes inside a band, erase them with the
// nearest-real-pixel row fill (no blur, preserves wrap texture/holo), and bake
// the replacement text (canvas Poppins at native res) at the detected position.
// Same technique as rebrand_bottom.mjs, generalized to per-icon op lists.
//
// Also promotes the two staged icons (docs/research/missing-tiers/) into
// public/images/claw/ once their extra brand zones are rebranded.
//   node scripts/rebrand-pokemon-icons.mjs [base ...]
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DIR = 'public/images/claw';
const STAGE = 'docs/research/missing-tiers';
const PREVIEW = 'docs/research/brand-audit/after';

const GRAY = [58, 58, 60];

// Op fields: band [x0,x1,y0,y1] (fractions), dir dark|light (ink vs band median),
// ink [r,g,b] erase-zone redraw colour, text, weight, fsScale (fs = blockH *
// fsScale), center (true: center text on the block; false: left-align at block
// left, baseline at block bottom), track (letter-spacing, em).
const URL_OP = (ink = GRAY) => ({
  key: 'url',
  band: [0.06, 0.75, 0.84, 0.905],
  dir: 'dark',
  ink,
  text: 'www.pokenic.com',
  weight: 400,
  fsScale: 1.04,
  center: false,
});
const STICKER_OP = (ink = [40, 40, 44]) => ({
  key: 'sticker',
  band: [0.68, 0.93, 0.76, 0.92],
  dir: 'dark',
  ink,
  text: 'P',
  weight: 800,
  fsScale: 1.35,
  center: true,
});

const ICONS = {
  'mythic-pack': { ops: [URL_OP(), STICKER_OP()] },
  'legend-pack': { ops: [URL_OP([52, 52, 54]), STICKER_OP()] },
  'elite-pack': { ops: [URL_OP([52, 52, 54]), STICKER_OP()] },
  'platinum-pack': { ops: [URL_OP([44, 44, 46]), STICKER_OP()] },
  'rookie-pack': { ops: [URL_OP([91, 45, 131]), STICKER_OP([70, 35, 110])] },
  'trainer-pack': { ops: [URL_OP([46, 46, 50]), STICKER_OP()] },
  'black-pack': {
    ops: [
      { ...URL_OP([198, 198, 204]), dir: 'light' },
      STICKER_OP([20, 20, 22]), // black glyph on the silver sticker
    ],
  },
  'diamond-pack': {
    ops: [
      { ...URL_OP([235, 235, 238]), dir: 'light' },
      // bare white logomark on the dark holo wrap (no sticker plate)
      {
        ...STICKER_OP([245, 245, 247]),
        dir: 'light',
        band: [0.55, 0.95, 0.75, 0.92],
      },
    ],
  },
  'sealed-pack': {
    src: `${STAGE}/sealed-pack-icon.webp`,
    ops: [URL_OP([46, 46, 50]), STICKER_OP()],
  },
  'base-set-pack': {
    src: `${STAGE}/base-set-pack-icon.webp`,
    ops: [
      // "PHYGITALS PRESENTS" headline (dark caps on wavy green lines — the row
      // fill follows the horizontal waves, so the erase stays invisible)
      {
        key: 'presents',
        band: [0.22, 0.8, 0.07, 0.12],
        dir: 'dark',
        ink: [24, 24, 26],
        text: 'POKENIC PRESENTS',
        weight: 700,
        fsScale: 1.25,
        center: true,
        track: 0.14,
      },
      // "by phygitals" white text on the green badge strip
      {
        key: 'badge',
        band: [0.06, 0.27, 0.835, 0.872],
        dir: 'light',
        ink: [250, 250, 250],
        text: 'by pokenic',
        weight: 700,
        fsScale: 1.0,
        center: true,
      },
      // "phygitals.io" wordmark, dark on the white wrap
      {
        key: 'io',
        band: [0.74, 0.98, 0.852, 0.888],
        dir: 'dark',
        ink: [28, 28, 30],
        text: 'pokenic.io',
        weight: 600,
        fsScale: 1.05,
        center: false,
      },
      // black P logomark above the wordmark
      {
        key: 'mark',
        band: [0.82, 0.97, 0.778, 0.852],
        dir: 'dark',
        ink: [16, 16, 18],
        text: 'P',
        weight: 800,
        fsScale: 1.3,
        center: true,
      },
    ],
  },
};

const argBases = process.argv.slice(2);
const jobs = Object.entries(ICONS)
  .filter(([b]) => !argBases.length || argBases.includes(b))
  .map(([base, cfg]) => ({
    base,
    src: cfg.src ?? `${DIR}/${base}-icon.webp`,
    dest: `${DIR}/${base}-icon.webp`,
    ops: cfg.ops,
  }));

await mkdir(PREVIEW, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
await page.addStyleTag({
  content:
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap');",
});
await page.waitForTimeout(1800);
await page.evaluate(async () => {
  await document.fonts.ready;
  for (const w of [400, 600, 700, 800]) {
    const ok = await document.fonts.load(`${w} 40px Poppins`);
    if (!ok.length) throw new Error(`Poppins ${w} failed to load`);
  }
});

for (const job of jobs) {
  const data =
    'data:image/webp;base64,' + (await readFile(job.src)).toString('base64');
  const res = await page.evaluate(
    async ({ data, ops }) => {
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
      let id = ctx.getImageData(0, 0, W, H);
      const log = [];

      for (const op of ops) {
        const od = new Uint8ClampedArray(id.data); // pre-op pixels
        const [fx0, fx1, fy0, fy1] = op.band;
        const bx0 = Math.round(fx0 * W),
          bx1 = Math.round(fx1 * W),
          by0 = Math.round(fy0 * H),
          by1 = Math.round(fy1 * H);
        // band median luminance -> stroke threshold
        const lum = [];
        for (let y = by0; y <= by1; y += 2)
          for (let x = bx0; x <= bx1; x += 2) {
            const p = (y * W + x) * 4;
            lum.push(od[p] + od[p + 1] + od[p + 2]);
          }
        lum.sort((a, b) => a - b);
        const medL = lum[lum.length >> 1];
        const TH = op.dir === 'dark' ? 150 : 120;
        const isHit = (s) =>
          op.dir === 'dark' ? s < medL - TH : s > medL + TH;

        // stroke bbox
        let lx = 1e9,
          rx = -1,
          ty = 1e9,
          byx = -1,
          n = 0;
        for (let y = by0; y <= by1; y++)
          for (let x = bx0; x <= bx1; x++) {
            const p = (y * W + x) * 4;
            if (isHit(od[p] + od[p + 1] + od[p + 2])) {
              if (x < lx) lx = x;
              if (x > rx) rx = x;
              if (y < ty) ty = y;
              if (y > byx) byx = y;
              n++;
            }
          }
        if (n < 30) {
          log.push(`${op.key}: SKIP (only ${n} stroke px in band)`);
          continue;
        }

        // erase: dilated stroke mask, nearest real pixel on the row
        const pad = 3,
          DIL = 2;
        const ex0 = Math.max(0, lx - pad),
          ex1 = Math.min(W - 1, rx + pad),
          ey0 = Math.max(0, ty - pad),
          ey1 = Math.min(H - 1, byx + pad);
        const mw = ex1 - ex0 + 1,
          mh = ey1 - ey0 + 1;
        const M = new Uint8Array(mw * mh);
        for (let y = ey0; y <= ey1; y++)
          for (let x = ex0; x <= ex1; x++) {
            const p = (y * W + x) * 4;
            if (isHit(od[p] + od[p + 1] + od[p + 2]))
              for (let dy = -DIL; dy <= DIL; dy++)
                for (let dx = -DIL; dx <= DIL; dx++) {
                  const ny = y - ey0 + dy,
                    nx = x - ex0 + dx;
                  if (ny >= 0 && ny < mh && nx >= 0 && nx < mw)
                    M[ny * mw + nx] = 1;
                }
          }
        const masked = (x, y) =>
          x >= ex0 &&
          x <= ex1 &&
          y >= ey0 &&
          y <= ey1 &&
          M[(y - ey0) * mw + (x - ex0)];
        const px = id.data;
        for (let y = ey0; y <= ey1; y++)
          for (let x = ex0; x <= ex1; x++) {
            if (!masked(x, y)) continue;
            let sl = x - 1;
            while (sl >= 0 && masked(sl, y)) sl--;
            let sr = x + 1;
            while (sr < W && masked(sr, y)) sr++;
            let src = -1;
            if (sl >= 0 && sr < W) src = x - sl <= sr - x ? sl : sr;
            else if (sl >= 0) src = sl;
            else if (sr < W) src = sr;
            else continue;
            const sp = (y * W + src) * 4,
              dp = (y * W + x) * 4;
            px[dp] = od[sp];
            px[dp + 1] = od[sp + 1];
            px[dp + 2] = od[sp + 2];
            px[dp + 3] = 255;
          }
        ctx.putImageData(id, 0, 0);

        // bake replacement
        const blockH = byx - ty + 1;
        const fs = Math.max(9, Math.round(blockH * op.fsScale * 0.72));
        ctx.fillStyle = `rgb(${op.ink[0]}, ${op.ink[1]}, ${op.ink[2]})`;
        ctx.textBaseline = 'alphabetic';
        ctx.font = `${op.weight} ${fs}px Poppins, sans-serif`;
        const track = (op.track ?? 0) * fs;
        const textW = op.track
          ? [...op.text].reduce(
              (a, c) => a + ctx.measureText(c).width + track,
              -track,
            )
          : ctx.measureText(op.text).width;
        // single-line ops: descender-less text sits ON the block bottom; text
        // with descenders (lowercase) gets the baseline lifted ~0.21em
        const hasDesc = /[gjpqy]/.test(op.text);
        const baseY = op.center
          ? Math.round((ty + byx) / 2 + fs * 0.36)
          : byx - (hasDesc ? Math.round(fs * 0.21) : 0);
        let drawX = op.center ? Math.round((lx + rx) / 2 - textW / 2) : lx;
        ctx.textAlign = 'left';
        if (op.track) {
          for (const c of op.text) {
            ctx.fillText(c, drawX, baseY);
            drawX += ctx.measureText(c).width + track;
          }
        } else {
          ctx.fillText(op.text, drawX, baseY);
        }
        id = ctx.getImageData(0, 0, W, H);
        log.push(
          `${op.key}: bbox=(${((lx / W) * 100).toFixed(1)}%,${((ty / H) * 100).toFixed(1)}%)-(${((rx / W) * 100).toFixed(1)}%,${((byx / H) * 100).toFixed(1)}%) fs=${fs} px=${n}`,
        );
      }
      return { webp: cv.toDataURL('image/webp', 0.95), log, W, H };
    },
    { data, ops: job.ops },
  );
  await writeFile(job.dest, Buffer.from(res.webp.split(',')[1], 'base64'));
  console.log(`${job.base} (${res.W}x${res.H}) -> ${job.dest}`);
  for (const l of res.log) console.log(`   ${l}`);
}
await browser.close();
console.log('done — re-run scripts/audit-pokemon-branding.mjs to verify');
