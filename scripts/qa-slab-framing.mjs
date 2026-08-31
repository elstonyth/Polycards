// qa-slab-framing.mjs — before/after proof that consolidating the slab framing
// (src/components/SlabImage.tsx and the surfaces that wrapped their own glow
// around it) changed NO pixels.
//
//   npm run build && pwsh scripts/serve-standalone.ps1 -Port 4100   # background
//   node scripts/qa-slab-framing.mjs --tag before
//   ...edit, rebuild, restart the server...
//   node scripts/qa-slab-framing.mjs --tag after
//   node scripts/qa-slab-framing.mjs --diff
//
// Shots land in docs/research/slab-framing-<tag>-<name>.png.
//
// Determinism notes (a diff is worthless if the page moves on its own):
//   * reduced motion is emulated, so <Reveal> paints its sections immediately
//     and nothing is mid-transition when the shutter opens. The tier band and
//     the halo are static box-shadows either way — reduced motion does not
//     touch them.
//   * connect.facebook.net is blocked. The Meta Pixel never settles, so any
//     networkidle wait hangs (see the qa-free-pack memory note); we wait on the
//     slab images themselves instead.
import { chromium } from 'playwright';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// 127.0.0.1, not localhost: node resolves localhost to ::1 first and hangs.
const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4100';
const OUT = 'docs/research';
const argv = process.argv.slice(2);
const tag = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : null;

/** Halo room: SlabImage's glow reaches ~44px past the slab edge, so an element
 *  clip has to be padded or the thing under test is the thing cropped off. */
const HALO = 70;

const padded = (box, page) => ({
  x: Math.max(0, box.x - HALO),
  y: Math.max(0, box.y - HALO),
  width: Math.min(page.width - Math.max(0, box.x - HALO), box.width + 2 * HALO),
  height: Math.min(
    page.height - Math.max(0, box.y - HALO),
    box.height + 2 * HALO,
  ),
});

async function settle(page) {
  // Every slab raster decoded — `complete` alone is true for a 404'd image, so
  // naturalWidth is the one that means "there are pixels here".
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('[data-slab] img')];
        return (
          imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0)
        );
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => console.warn('  ! slab images did not all settle'));
  await page.waitForTimeout(600);
}

async function capture() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await page.route('**://connect.facebook.net/**', (r) => r.abort());
  const shot = async (name, opts) => {
    const file = path.join(OUT, `slab-framing-${tag}-${name}.png`);
    await page.screenshot({ path: file, ...opts });
    console.log(`  wrote ${file}`);
  };

  // Pack slug from the catalog, never hardcoded — the local catalog is a prod
  // mirror and its slugs move (e2e-prod-catalog-mirror memory note).
  await page.goto(`${BASE}/slots`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href^="/slots/"]', { timeout: 30_000 });
  // The catalog link carries a `?count=1` query — strip it, or `${slug}/spin`
  // lands back on the pack page instead of the machine.
  const slug = (
    await page.$eval('a[href^="/slots/"]', (a) => a.getAttribute('href'))
  ).split('?')[0];
  console.log(`pack: ${slug}`);

  // 1 + 2. Pack detail: the card GRID (components/cards/CardTile -> SlabImage,
  // the surface that already delegates) and one graded slab up close.
  await page.goto(`${BASE}${slug}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const slabs = page.locator('[data-slab]');
  const n = await slabs.count();
  console.log(`  ${n} slabs on the pack page`);
  const first = slabs.first();
  // Centred, not merely in view: the buy dock is sticky at the bottom and would
  // otherwise sit across the halo this shot exists to show.
  await first.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  const vp = page.viewportSize();
  const box = await first.boundingBox();
  if (box) {
    // The tile ROW, not the viewport: a viewport shot also catches the pack
    // hero and the sticky dock, which move between runs and drown the thing
    // under test in noise (measured: maxDelta 92 on two runs of ONE build,
    // vs 0 for the clips below).
    await shot('pack-grid', {
      clip: {
        x: 0,
        y: Math.max(0, box.y - 90),
        width: vp.width,
        height: Math.min(vp.height - Math.max(0, box.y - 90), box.height + 190),
      },
    });
    await shot('slab-closeup', { clip: padded(box, vp) });
  }

  // 3. Card detail (components/cards/CardDetail): the ambient page glow that
  // used to be spelled out at the call site. The pool tile opens the overlay,
  // which renders the same component the /card/[handle] page does.
  await first.click({ force: true });
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await settle(page);
  await shot('card-detail', { fullPage: false });

  // 4. Idle reel (slots/[slug]/CardTile + PokemonToken): no spin needed — the
  // strip drifts with winIdx null and every cell lit.
  await page.goto(`${BASE}${slug}/spin`, { waitUntil: 'domcontentloaded' });
  // Sprites come from raw.githubusercontent.com and are the slowest thing on
  // the page; without them the cells shoot empty and the token under test is
  // not in the frame at all.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('img')].filter(
          (i) => i.naturalWidth > 0 && i.src.includes('sprites'),
        ).length > 4,
      null,
      { timeout: 30_000 },
    )
    .catch(() => console.warn('  ! reel sprites did not load'));
  await page.waitForTimeout(1500);
  await shot('reel-idle', { fullPage: false });

  await browser.close();
}

async function diff() {
  const files = (await readdir(OUT)).filter((f) =>
    f.startsWith('slab-framing-before-'),
  );
  let worst = 0;
  for (const f of files) {
    const name = f.replace('slab-framing-before-', '');
    const a = path.join(OUT, f);
    const b = path.join(OUT, `slab-framing-after-${name}`);
    try {
      const [ra, rb] = await Promise.all(
        [a, b].map((p) =>
          sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        ),
      );
      if (
        ra.info.width !== rb.info.width ||
        ra.info.height !== rb.info.height
      ) {
        console.log(`${name}: SIZE MISMATCH`);
        worst = 255;
        continue;
      }
      let differing = 0;
      let maxDelta = 0;
      for (let i = 0; i < ra.data.length; i++) {
        const d = Math.abs(ra.data[i] - rb.data[i]);
        if (d > 0) differing++;
        if (d > maxDelta) maxDelta = d;
      }
      const pct = ((differing / ra.data.length) * 100).toFixed(4);
      worst = Math.max(worst, maxDelta);
      console.log(
        `${name}: maxDelta=${maxDelta} differingChannels=${differing} (${pct}%)`,
      );
    } catch (e) {
      console.log(`${name}: ${e.message}`);
    }
  }
  console.log(worst === 0 ? 'IDENTICAL' : `WORST CHANNEL DELTA ${worst}`);
}

if (argv.includes('--diff')) await diff();
else if (tag) await capture();
else {
  console.error('usage: --tag before|after   |   --diff');
  process.exit(1);
}
