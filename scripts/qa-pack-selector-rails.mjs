// Pack detail picker — verify the shelves (pack type chips, language chips,
// the Graded / Raw Cards / More groups and their tiles) at phone width and at
// lg (sticky right column). The file keeps its old name: the picker was
// sideways rails until 2026-11-18, and `pack-rail` is still the tile list's
// test id.
// Usage: node scripts/qa-pack-selector-rails.mjs [slug]
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const SLUG = process.argv[2] ?? 'diamond-pack';
const b = await chromium.launch();

for (const [label, viewport] of [
  ['mobile', { width: 393, height: 852 }],
  ['desktop', { width: 1440, height: 900 }],
]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 2 });
  // Pre-set the consent choice (rejected — non-essential off) so the banner
  // never overlaps the panel in the shot. Not a click: this is a QA harness,
  // not a user answering the prompt.
  await ctx.addInitScript(() =>
    window.localStorage.setItem('polycards.cookie-consent', 'rejected'),
  );
  const p = await ctx.newPage();
  // `load`, not `networkidle`: Next leaks duplicate RSC prefetches that never
  // finish, so networkidle never fires on a page that navigates.
  await p.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'load', timeout: 60000 });
  await p.locator('h1').first().waitFor();
  await p.waitForTimeout(1200);

  const panel = p.locator('aside').first();
  await panel.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await panel.screenshot({ path: `docs/research/pack-selector-${label}.png` });

  // Anchored on the selector's test ids, so a copy or wrapper change in the
  // configurator doesn't silently turn this probe into "no groups found".
  const state = await p.evaluate(() => {
    const box = document.querySelector('[data-testid="pack-selector"]');
    if (!box) return { error: 'pack-selector not found' };
    const chips = (name) =>
      [...box.querySelectorAll(`[aria-label="${name}"] button`)].map((c) => ({
        label: c.textContent?.trim(),
        on: c.getAttribute('aria-pressed') === 'true',
      }));
    const aside = document.querySelector('aside');
    const scroller = aside?.firstElementChild;
    return {
      facts: document
        .querySelector('[data-testid="pack-facts"]')
        ?.textContent?.trim(),
      types: chips('Pack type'),
      languages: chips('Language'),
      groups: [
        ...box.querySelectorAll('[data-testid="pack-selector-group"]'),
      ].map((g) => {
        const list = g.querySelector('[data-testid="pack-rail"]');
        if (!list) return { error: 'pack-rail not found in group' };
        const tiles = [...list.querySelectorAll('a')];
        const prices = tiles.map((t) =>
          Number(
            t.textContent?.replace(/,/g, '').match(/RM\s*([\d.]+)/)?.[1] ?? NaN,
          ),
        );
        return {
          heading: g.querySelector('p')?.textContent?.trim(),
          tiles: tiles.length,
          cheapestFirst: prices.every((n, i) => i === 0 || prices[i - 1] <= n),
          // Nothing may need a sideways swipe any more.
          swipes: list.scrollWidth > list.clientWidth + 1,
          current:
            list.querySelector('a[aria-current="page"]')?.textContent?.trim() ??
            null,
        };
      }),
      // lg only: the panel scrolls inside itself when the shelf outgrows it.
      panelScrolls: scroller
        ? scroller.scrollHeight > scroller.clientHeight + 1
        : null,
    };
  });
  console.log(label, JSON.stringify(state, null, 2));
  await ctx.close();
}

console.log('saved docs/research/pack-selector-{mobile,desktop}.png');
await b.close();
