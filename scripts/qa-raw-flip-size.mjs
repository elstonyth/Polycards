// QA — the reveal's flip surface: the card BACK must match the pull it flips
// into, and neither face may change size or position across the flip.
//
//   RAW pull    → back is the bare card stock (public/images/app/
//                 polycards-card-back.webp), never the acrylic slab case, and
//                 the tier band is the same box on both faces.
//   GRADED pull → back is the slab case, sized to the case on the FRONT (which
//                 SlabImage draws inset by FRAME_BAND% inside the band).
//
// BOTH modes must pass — the graded path is the entire live catalog, so a
// raw-only run proves nothing about what players actually see:
//   node scripts/qa-raw-flip-size.mjs                 # raw   (forced, see below)
//   QA_FORCE_RAW=0 node scripts/qa-raw-flip-size.mjs  # graded (real pool)
//
// Prod standalone build on :4000 (NOT next dev). Backend must be up — the spin
// page is server-rendered from it. Guest demo spin, so no login and no POSTs.
import { chromium } from 'playwright';

const BASE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const PACK = process.env.QA_PACK ?? 'bronze-pack';
const OUT = process.env.QA_OUT ?? 'docs/research';
const FORCE_RAW = process.env.QA_FORCE_RAW !== '0';
const MODE = FORCE_RAW ? 'raw' : 'graded';

let failed = false;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};

// Every <img> inside the flip button, split by face, with rects measured
// RELATIVE TO THE BUTTON. Absolute coords would race the pre-flip idle float
// (SlabCard animates y: [0,-4,0] forever, and this context deliberately runs
// with reducedMotion 'no-preference') — the whole button bobs together, so
// button-relative geometry is float-invariant and the two faces stay comparable.
const faces = (page) =>
  page.evaluate(() => {
    const btn = document.querySelector(
      'button[aria-label="Flip to reveal your card"], button[aria-label]:has(span[data-slab])',
    );
    if (!btn) return null;
    const br = btn.getBoundingClientRect();
    const [back, front] = btn.querySelectorAll(':scope > span');
    const shot = (root) =>
      root
        ? [...root.querySelectorAll('img')].map((im) => {
            const r = im.getBoundingClientRect();
            return {
              src: im.currentSrc || im.src,
              w: Math.round(r.width),
              h: Math.round(r.height),
              x: Math.round(r.left - br.left),
              y: Math.round(r.top - br.top),
            };
          })
        : [];
    return {
      box: { w: Math.round(br.width), h: Math.round(br.height) },
      back: shot(back),
      front: shot(front),
    };
  });

// The face's SUBJECT: the case/card raster the eye tracks through the flip —
// i.e. everything that isn't the tier band. The band is chrome that legitimately
// differs (a graded back has none; it grows in on flip), so comparing largest-
// rect-to-largest-rect would compare a band against a case and pass vacuously.
const subject = (imgs) => {
  const hits = imgs.filter((i) => !/(slab|raw)-frames/.test(i.src));
  return hits.length
    ? hits.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b))
    : null;
};
const fmt = (r) => (r ? `${r.w}x${r.h} @${r.x},${r.y}` : 'none');

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  // Force the RAW path without touching the DB: blank every baked slab URL in
  // the streamed HTML/RSC payload, so the client sees `slab_image: ""`. Prod
  // sends `null` for an ungraded card, but every consumer branches on falsiness
  // (`!card.slab_image` in SlabCard, `slabSrc ?` in SlabImage), so "" and null
  // take the identical path. Needed because the local catalog is a mirror of the
  // all-graded prod catalog and the raw-pool packs (pokemon-elite/-rookie) are
  // `draft`, so no served pack can produce a raw pull on demand.
  let rewrites = 0;
  if (FORCE_RAW) {
    await page.route('**/slots/**', async (route) => {
      const res = await route.fetch();
      const ct = res.headers()['content-type'] ?? '';
      if (!/text\/html|text\/x-component/.test(ct))
        return route.fulfill({ response: res });
      // Matches both the Spaces CDN and a local file-provider origin.
      const body = (await res.text()).replace(
        /https?:\\?\/\\?\/[^"\\ ]*?slab-[^"\\ ]*?\.webp/g,
        () => ((rewrites += 1), ''),
      );
      await route.fulfill({ response: res, body });
    });
  }
  await page.goto(`${BASE}/slots/${PACK}/spin?demo=1`, {
    waitUntil: 'domcontentloaded',
  });
  const spinCta = page.getByRole('button', { name: /^demo spin$/i });
  await spinCta.waitFor({ timeout: 20000 });
  await page
    .getByRole('button', { name: /^(Accept|Reject)$/ })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  // A rewrite that matched nothing would silently run the GRADED path and then
  // fail the raw assertion below, blaming the product for a harness miss.
  if (FORCE_RAW && rewrites === 0)
    throw new Error(
      'QA_FORCE_RAW matched no slab URLs — the payload shape changed; fix the regex',
    );
  await spinCta.click();
  await page.getByText('Tap the card to reveal').waitFor({ timeout: 60000 });
  await page.waitForTimeout(600); // entrance morph settles

  const before = await faces(page);
  if (!before) throw new Error('flip button not found');
  await page.screenshot({ path: `${OUT}/qa-flip-${MODE}-back.png` });
  console.log(`[${MODE}] BACK imgs:`, JSON.stringify(before.back, null, 1));

  const backSrcs = before.back.map((i) => i.src);
  const rawBack = backSrcs.some((s) => /polycards-card-back/.test(s));
  const slabBack = backSrcs.some((s) => /polycards-slab-back/.test(s));
  if (FORCE_RAW) {
    if (rawBack && !slabBack)
      ok('raw pull shows the bare card back (no slab case)');
    else if (slabBack) fail('slab-case back still rendered on a raw pull');
    else fail(`no known card back on the back face: ${backSrcs.join(', ')}`);
  } else {
    if (slabBack && !rawBack) ok('graded pull keeps the slab-case back');
    else if (rawBack) fail('bare card back rendered on a GRADED pull');
    else fail(`no known card back on the back face: ${backSrcs.join(', ')}`);
  }

  await page
    .getByRole('button', { name: 'Flip to reveal your card' })
    .first()
    .click({ force: true });
  await page.waitForTimeout(1600); // rotateY + settle
  const after = await faces(page);
  await page.screenshot({ path: `${OUT}/qa-flip-${MODE}-front.png` });
  console.log(`[${MODE}] FRONT imgs:`, JSON.stringify(after.front, null, 1));

  const sBack = subject(before.back);
  const sFront = subject(after.front);
  console.log(
    `[${MODE}] box ${before.box.w}x${before.box.h} | back ${fmt(sBack)} | front ${fmt(sFront)}`,
  );
  if (!sBack || !sFront) {
    fail(`missing subject raster — back ${fmt(sBack)}, front ${fmt(sFront)}`);
  } else {
    if (
      Math.max(Math.abs(sBack.w - sFront.w), Math.abs(sBack.h - sFront.h)) <= 1
    )
      ok('front and back measure the same size');
    else fail(`flip size jump: back ${fmt(sBack)} vs front ${fmt(sFront)}`);
    if (Math.abs(sBack.x - sFront.x) <= 1 && Math.abs(sBack.y - sFront.y) <= 1)
      ok('front and back share the same position');
    else
      fail(`flip position shift: back ${fmt(sBack)} vs front ${fmt(sFront)}`);
  }

  await ctx.close();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
