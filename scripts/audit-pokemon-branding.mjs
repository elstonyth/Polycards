// Task E v2 Phase 1 — brand-zone crops for every POKEMON claw asset, so the
// phygitals-branding audit is done by eye (color detection alone proved
// unreliable — see the doubled-wordmark incident in AUDIT_PUNCHLIST).
// Crops → docs/research/brand-audit/<base>-<zone>.png at 2x zoom.
//   node scripts/audit-pokemon-branding.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = 'docs/research/brand-audit';
await mkdir(OUT, { recursive: true });

const POKEMON_BASES = [
  'mythic-pack',
  'legend-pack',
  'elite-pack',
  'platinum-pack',
  'rookie-pack',
  'trainer-pack',
  'black-pack',
  'diamond-pack',
];

// [name, path, zones]; zone rect = fractions [x0, x1, y0, y1] of the image.
const jobs = [];
for (const b of POKEMON_BASES) {
  jobs.push({
    name: `${b}-icon`,
    path: `public/images/claw/${b}-icon.webp`,
    zones: {
      url: [0.05, 0.7, 0.8, 0.96], // tier name + www.* line, bottom-left
      sticker: [0.6, 1.0, 0.72, 0.98], // white P-logo sticker, bottom-right
      top: [0.0, 1.0, 0.08, 0.26], // POKEMON TRADING CARDS band (generic check)
    },
  });
  jobs.push({
    name: `${b}-machine`,
    path: `public/images/claw/${b}-machine.webp`,
    zones: {
      banner: [0.15, 0.85, 0.02, 0.2], // top banner
      placard: [0.25, 0.75, 0.68, 0.88], // placard text block
      baseurl: [0.25, 0.75, 0.85, 0.99], // url on the base
    },
  });
}
// the two staged icons (full-surface check: they have extra brand zones)
for (const n of ['sealed-pack-icon', 'base-set-pack-icon']) {
  jobs.push({
    name: `staged-${n}`,
    path: `docs/research/missing-tiers/${n}.webp`,
    zones: {
      top: [0.0, 1.0, 0.0, 0.25],
      mid: [0.0, 1.0, 0.25, 0.72],
      bottom: [0.0, 1.0, 0.72, 1.0],
    },
  });
}

const present = jobs.filter((j) => existsSync(j.path));
for (const j of jobs) if (!existsSync(j.path)) console.log('MISSING', j.path);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

for (const job of present) {
  const data =
    'data:image/webp;base64,' + (await readFile(job.path)).toString('base64');
  const crops = await page.evaluate(
    async ({ data, zones }) => {
      const img = await new Promise((ok, no) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => no(new Error('load'));
        im.src = data;
      });
      const W = img.naturalWidth,
        H = img.naturalHeight;
      const out = { W, H, crops: {} };
      for (const [zone, [x0, x1, y0, y1]] of Object.entries(zones)) {
        const sx = Math.round(x0 * W),
          sw = Math.round((x1 - x0) * W),
          sy = Math.round(y0 * H),
          sh = Math.round((y1 - y0) * H);
        const cv = document.createElement('canvas');
        cv.width = sw * 2;
        cv.height = sh * 2;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw * 2, sh * 2);
        out.crops[zone] = cv.toDataURL('image/png');
      }
      return out;
    },
    { data, zones: job.zones },
  );
  for (const [zone, url] of Object.entries(crops.crops)) {
    await writeFile(
      `${OUT}/${job.name}-${zone}.png`,
      Buffer.from(url.split(',')[1], 'base64'),
    );
  }
  console.log(
    `${job.name} (${crops.W}x${crops.H}) -> ${Object.keys(crops.crops).join(', ')}`,
  );
}
await browser.close();
console.log('done');
