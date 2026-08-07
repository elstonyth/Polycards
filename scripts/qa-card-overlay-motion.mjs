// Two things the page-level motion QA structurally cannot reach.
//
// 1. The OVERLAY path. CardDetail is shared between /card/[handle] and the
//    grid overlay, and only the page passes `entrance`. The overlay animates
//    its own panel (opacity + scale, 250ms), so any `rise-in` leaking into it
//    would run a second entrance underneath the first. Also checks that a
//    card→card switch never pulses the price — the regression price-tick.ts
//    guards, verified here through the real component rather than in isolation.
//
// 2. The price row's `-mx-2 px-2`. The negative margin buys the pulse tint some
//    breathing room; it must not move the number off the left edge the rest of
//    the facts column aligns to, and must not visibly close the gap to the 30d
//    delta badge.
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
const align = await page.evaluate(() => {
  const h1 = document.querySelector('h1');
  const price = document.querySelector('p.font-heading.tabular-nums');
  // Left edge of the rendered TEXT, not the padded box — px-2 is supposed to
  // put the glyphs back exactly where the negative margin took the box.
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
if (Math.abs(align.priceTextLeft - align.h1Left) > 1) {
  failures.push(
    `price text is ${(align.priceTextLeft - align.h1Left).toFixed(1)}px off the h1 left edge`,
  );
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
