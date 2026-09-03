// QA gate: the pixel-Pokémon badge on card slabs — pack rail, Top Hits dialog,
// card-detail overlay, mobile, reduced motion, and the raw-card anchor.
//
// Usage: PW_BASE=http://127.0.0.1:4100 node scripts/qa-pokemon-badge.mjs
// Screenshots to docs/research/qa-pokemon-badge-*.png. EXITS NON-ZERO on a
// failed probe — a script that only prints is green on a build that never had
// the feature in it (the :4000 stale-build trap), which is worse than no gate.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

// Default :4100, not :4000 — a worktree serves there because :4000 can be held
// by a stale main-tree build (see the worktree notes in CLAUDE.md).
const BASE = process.env.PW_BASE ?? process.argv[2] ?? 'http://127.0.0.1:4100';
mkdirSync('docs/research', { recursive: true });

const DIALOG_SEL =
  '[role="dialog"][aria-label="Top Hits"], [role="dialog"][aria-label="All cards"]';
const TILE = 'button[aria-label^="View details for"]';
// A selector LIST doesn't distribute a suffix — prefixing DIALOG_SEL would
// leave the first alternative matching the whole dialog. Distribute by hand.
const DIALOG_TILE = DIALOG_SEL.split(', ')
  .map((d) => `${d} ${TILE}`)
  .join(', ');
// Match the badge STRUCTURALLY (PokemonBadge stamps data-poke-badge), never by
// URL: an admin-configured sprite is an arbitrary Spaces object, so a
// `src*="sprites"` probe counts only the cards WITHOUT one — it read 0 badges
// on a page that was rendering eight. `img[src*="pokemon"]` is worse still:
// catalog rows hotlink pokemoncenter.com through /_next/image, so it would
// count slab art as badges.
const BADGE = 'img[data-poke-badge]';
const BADGE_IMG = `${TILE} ${BADGE}`;
/** A dex sprite from the sprite CDN — the only source whose format we control.
 *  An operator gif upload has no static counterpart (see PokemonBadge). */
const isDexGif = (src) => src.includes('/showdown/') && src.endsWith('.gif');

let anyFailure = false;
const fail = (msg) => {
  anyFailure = true;
  console.log(`FAIL: ${msg}`);
};

/** Badge wrapper width ÷ slab box width — this is what proves the badge is
 *  anchored to the ARTWORK and not to the slab box. A raw card's art is inset
 *  inside the SLAB_ASPECT box, so a box-anchored badge hangs off the card. */
const anchorRatio = (page) =>
  page.evaluate(() => {
    // Start from a BADGE and walk out to its own slab. Starting from the first
    // [data-slab] on the page picks a background tile once a dialog is open.
    const img = document.querySelector('img[data-poke-badge]');
    const wrap = img?.closest('span')?.parentElement;
    const slab = wrap?.parentElement?.querySelector('[data-slab]');
    if (!slab || !wrap) return null;
    return (
      wrap.getBoundingClientRect().width / slab.getBoundingClientRect().width
    );
  });

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  // Meta Pixel never settles — block it or any networkidle wait hangs.
  await ctx.route('**connect.facebook.net**', (r) => r.abort());
  const page = await ctx.newPage();

  await page.goto(`${BASE}/slots`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const slugs = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('a[href^="/slots/"]')]
        .map((a) => a.getAttribute('href').replace('/slots/', '').split('?')[0])
        .filter((s) => s && !s.includes('/')),
    ),
  ]);
  if (slugs.length === 0) fail('no pack slugs on /slots');

  let graded = null;
  for (const slug of slugs) {
    await page.goto(`${BASE}/slots/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    if ((await page.locator(TILE).count()) > 0) {
      graded = slug;
      break;
    }
  }
  if (!graded) throw new Error('no pack renders card tiles — wrong build?');
  console.log(JSON.stringify({ base: BASE, slugs, graded }));

  // --- 1) rail ---------------------------------------------------------
  const railTiles = await page.locator(TILE).count();
  const railBadges = await page.locator(BADGE_IMG).count();
  console.log(JSON.stringify({ railTiles, railBadges }));
  if (railBadges === 0) fail(`rail renders 0 badges on ${graded}`);
  const gradedRatio = await anchorRatio(page);
  console.log(JSON.stringify({ gradedAnchorRatio: gradedRatio }));
  // Graded + framed: the composite is inset 5% each side → 0.90 of the box.
  if (gradedRatio === null || Math.abs(gradedRatio - 0.9) > 0.02) {
    fail(`graded badge not anchored to the slab composite (${gradedRatio})`);
  }
  await page.locator(TILE).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'docs/research/qa-pokemon-badge-rail.png' });

  // --- 2) Top Hits dialog ----------------------------------------------
  await page.locator('button[aria-haspopup="dialog"]').first().click();
  await page.waitForSelector(DIALOG_SEL, { timeout: 5000 });
  await page.waitForTimeout(2000);
  const dialogBadges = await page.locator(`${DIALOG_TILE} ${BADGE}`).count();
  if (dialogBadges === 0) fail('Top Hits dialog renders 0 badges');
  await page.screenshot({ path: 'docs/research/qa-pokemon-badge-dialog.png' });
  await page
    .locator(DIALOG_TILE)
    .first()
    .screenshot({ path: 'docs/research/qa-pokemon-badge-tile.png' });

  // --- 3) card-detail overlay ------------------------------------------
  await page.locator(DIALOG_TILE).first().click();
  await page.waitForTimeout(2500);
  if ((await page.locator(BADGE).count()) === 0) {
    fail('card-detail overlay renders no badge');
  }
  await page.screenshot({ path: 'docs/research/qa-pokemon-badge-overlay.png' });
  await ctx.close();

  // --- 4) mobile -------------------------------------------------------
  // The badge is smallest exactly here (a w-[38%] rail tile on a 390px
  // viewport) — the size a desktop-only pass never looks at.
  const mob = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await mob.route('**connect.facebook.net**', (r) => r.abort());
  const mp = await mob.newPage();
  await mp.goto(`${BASE}/slots/${graded}`, { waitUntil: 'domcontentloaded' });
  await mp.waitForTimeout(2500);
  const mobileBadges = await mp.locator(BADGE_IMG).count();
  console.log(JSON.stringify({ mobileBadges }));
  if (mobileBadges === 0) fail('mobile rail renders 0 badges');
  await mp.locator(TILE).first().scrollIntoViewIfNeeded();
  await mp.waitForTimeout(1200);
  await mp.screenshot({ path: 'docs/research/qa-pokemon-badge-mobile.png' });
  await mob.close();

  // --- 5) reduced motion -----------------------------------------------
  // A gif cannot be paused by CSS, so the ONLY reduced-motion lever is not
  // loading one. This is the probe that would have caught shipping it ungated.
  const rm = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await rm.route('**connect.facebook.net**', (r) => r.abort());
  const rp = await rm.newPage();
  await rp.goto(`${BASE}/slots/${graded}`, { waitUntil: 'domcontentloaded' });
  await rp.waitForTimeout(3000);
  const srcs = await rp
    .locator(BADGE_IMG)
    .evaluateAll((els) => els.map((e) => e.currentSrc || e.src));
  const gifs = srcs.filter(isDexGif).length;
  console.log(JSON.stringify({ reducedMotionBadges: srcs.length, gifs }));
  if (srcs.length === 0) fail('reduced-motion pass renders 0 badges');
  if (gifs > 0) fail(`${gifs} animated dex gifs under prefers-reduced-motion`);
  await rm.close();

  // --- 6) raw pack ------------------------------------------------------
  // A raw card's art is INSET inside the slab box; a badge anchored to the box
  // corner floats in the transparent margin. Skipped LOUDLY when the local
  // catalog has no raw pack — silence would read as a pass.
  const rawSlug = slugs.find((s) => s.includes('raw'));
  if (!rawSlug) {
    console.log('SKIP: no raw pack in this catalog — raw anchor unverified');
  } else {
    const rc = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await rc.route('**connect.facebook.net**', (r) => r.abort());
    const rpg = await rc.newPage();
    await rpg.goto(`${BASE}/slots/${rawSlug}`, {
      waitUntil: 'domcontentloaded',
    });
    await rpg.waitForTimeout(2500);
    // A pack with no TOP-TIER cards has no rail strip at all (PoolByRarity
    // skips it and falls back to the full pool inside the dialog), so the raw
    // pack's tiles only exist once the dialog is open. Measuring the page
    // first is how this probe silently skipped itself.
    await rpg.locator('button[aria-haspopup="dialog"]').first().click();
    await rpg.waitForSelector(DIALOG_SEL, { timeout: 5000 });
    await rpg.waitForTimeout(2000);
    if ((await rpg.locator(DIALOG_TILE).count()) === 0) {
      console.log(`SKIP: ${rawSlug} lists no cards`);
    } else {
      const rawRatio = await anchorRatio(rpg);
      console.log(JSON.stringify({ rawSlug, rawAnchorRatio: rawRatio }));
      // Raw + framed: the glass band spans (1112 + 2×64)/1600 = 0.775 of the box.
      if (rawRatio === null || Math.abs(rawRatio - 0.775) > 0.02) {
        fail(`raw badge not anchored to the card band (${rawRatio})`);
      }
      await rpg
        .locator(DIALOG_TILE)
        .first()
        .screenshot({ path: 'docs/research/qa-pokemon-badge-raw.png' });
    }
    await rc.close();
  }
} finally {
  await browser.close();
}

if (anyFailure) process.exitCode = 1;
console.log(anyFailure ? 'FAILED' : 'done');
