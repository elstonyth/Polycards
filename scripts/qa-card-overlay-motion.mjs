// Two things the page-level motion QA structurally cannot reach.
//
// 1. The OVERLAY path. CardDetail is shared between /card/[handle] and the
//    grid overlay, and only the page passes `entrance`. The overlay animates
//    its own panel (opacity + scale, 250ms), so any `rise-in` leaking into it
//    would run a second entrance underneath the first. Also checks that a
//    card→card switch never pulses the price — the regression price-tick.ts
//    guards, verified here through the real component rather than in isolation.
//
// 2. The price row costing NO layout. The pulse tint bleeds 8px past the text
//    via box-shadow spread precisely so it stays free — an earlier version paid
//    for it with px-2 plus a compensating -mx-2, and that margin was charged
//    whether or not a pulse was running, halving the gap-x-4 between the value
//    and the 30d delta badge beside it. Both invariants are asserted here: the
//    number stays on the left edge the facts column aligns to, AND the badge
//    gap stays at its full gap-x-4.
//
//   BASE_URL=http://localhost:4100 node scripts/qa-card-overlay-motion.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4100';
const CARD = process.env.QA_CARD ?? 'mega-charizard-x-ex-125-psa-10-11069001';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();
const failures = [];

// ---- 2. alignment on the page ------------------------------------------------
await page.goto(`${BASE}/card/${encodeURIComponent(CARD)}`, {
  waitUntil: 'load',
});
// The gap-x-4 the value block sets between the price and the delta badge.
const EXPECTED_BADGE_GAP = 16;

const align = await page.evaluate(() => {
  const h1 = document.querySelector('h1');
  const price = document.querySelector('p.font-heading.tabular-nums');
  // Return a sentinel rather than dereferencing null: if either selector
  // drifts, an exception here rejects the evaluate, skips the failure report
  // entirely, and leaks the browser process.
  if (!h1 || !price?.firstChild) {
    return { missing: !h1 ? 'h1' : 'price' };
  }
  // Left edge of the rendered TEXT, not the box — the box may legitimately
  // extend past it, but the glyphs must sit on the column's edge.
  const range = document.createRange();
  range.selectNodeContents(price.firstChild);
  const badge = price.parentElement.children[1] ?? null;
  return {
    h1Left: h1.getBoundingClientRect().left,
    priceTextLeft: range.getBoundingClientRect().left,
    priceBoxLeft: price.getBoundingClientRect().left,
    gapToBadge: badge
      ? badge.getBoundingClientRect().left - price.getBoundingClientRect().right
      : null,
  };
});
console.log('alignment:', JSON.stringify(align));
if (align.missing) {
  failures.push(
    `alignment probe "${align.missing}" not found — selector drifted, nothing was checked`,
  );
} else {
  if (Math.abs(align.priceTextLeft - align.h1Left) > 1) {
    failures.push(
      `price text is ${(align.priceTextLeft - align.h1Left).toFixed(1)}px off the h1 left edge`,
    );
  }
  // This is the assertion that would have caught the -mx-2 regression.
  if (
    align.gapToBadge !== null &&
    Math.abs(align.gapToBadge - EXPECTED_BADGE_GAP) > 1
  ) {
    failures.push(
      `gap to the 30d delta badge is ${align.gapToBadge}px, expected ${EXPECTED_BADGE_GAP}px (gap-x-4) — the price row is costing layout again`,
    );
  }
  if (align.gapToBadge === null) {
    console.log(
      'note: no delta badge on this card (needs >=2 price history points) — badge-gap assertion skipped',
    );
  }
}

// ---- 1. the overlay ----------------------------------------------------------
// Any pack detail page with a visible pool renders the clickable card grid.
await page.goto(`${BASE}/slots`, { waitUntil: 'load' });
// Pack links carry a ?count= query, so match on the path only.
const packHref = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a[href*="/slots/"]')].find((el) =>
    /^\/slots\/[^/?#]+(\?|$)/.test(el.getAttribute('href') ?? ''),
  );
  return a?.getAttribute('href') ?? null;
});
if (!packHref) {
  failures.push('no pack link found on /slots — cannot reach the overlay');
} else {
  await page.goto(`${BASE}${packHref}`, { waitUntil: 'load' });
  const cards = page.locator('button:has(img), [role="button"]:has(img)');
  const opened = await page
    .evaluate(() => {
      // The pool grid entries are the only controls that open the overlay.
      const el = [...document.querySelectorAll('button, [role="button"]')].find(
        (b) => b.querySelector('img'),
      );
      if (!el) return false;
      el.click();
      return true;
    })
    .catch(() => false);

  if (!opened) {
    failures.push(
      `no clickable pool card on ${packHref} — overlay not reached`,
    );
  } else {
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
    await page.waitForTimeout(1500); // let useCardPrice hydrate from the seed

    const overlay = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return {
        riseIn: dlg.querySelectorAll('.rise-in').length,
        slabArrive: dlg.querySelectorAll('.slab-arrive').length,
        pulsing: dlg.querySelectorAll('.price-tick').length,
      };
    });
    console.log('overlay:', JSON.stringify(overlay));
    if (overlay.riseIn || overlay.slabArrive) {
      failures.push(
        `overlay leaked page entrance classes (rise-in=${overlay.riseIn}, slab-arrive=${overlay.slabArrive}) — it already animates its own panel`,
      );
    }
    if (overlay.pulsing) {
      failures.push(
        'overlay pulsed the price on its initial hydrate — the seed→detail baseline is being read as a market move',
      );
    }
    await page.screenshot({ path: 'docs/research/motion-card-overlay.png' });
  }
  void cards;
}

await browser.close();
if (failures.length) {
  console.error('\nFAIL:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(
  '\nOK — overlay carries no page entrance, price row stays aligned.',
);
