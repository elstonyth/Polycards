// Pack detail sibling selector — verify the composition rails (Graded / Raw /
// More) render and swipe, at phone width and at lg (sticky right column).
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
  await p.goto(`${BASE}/slots/${SLUG}`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await p.waitForTimeout(1200);

  const panel = p.locator('aside').first();
  await panel.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await panel.screenshot({ path: `docs/research/pack-selector-${label}.png` });

  // What the rails actually contain + whether the arrived-on pack is centred.
  // Anchored on the selector's test ids, so a copy or wrapper change in the
  // configurator doesn't silently turn this probe into "no groups found".
  const state = await p.evaluate(() => {
    const box = document.querySelector('[data-testid="pack-selector"]');
    if (!box) return { error: 'pack-selector not found' };
    return {
      groups: [
        ...box.querySelectorAll('[data-testid="pack-selector-group"]'),
      ].map((g) => {
        const rail = g.querySelector('[data-testid="pack-rail"]');
        if (!rail) return { error: 'pack-rail not found in group' };
        const active = rail.querySelector('button[aria-pressed="true"]');
        return {
          heading: g.querySelector('p')?.textContent?.trim(),
          tiles: rail.querySelectorAll('button').length,
          scrollable: rail.scrollWidth > rail.clientWidth + 1,
          scrollLeft: Math.round(rail.scrollLeft),
          activeVisible: active
            ? active.offsetLeft >= rail.scrollLeft - 1 &&
              active.offsetLeft + active.clientWidth <=
                rail.scrollLeft + rail.clientWidth + 1
            : null,
        };
      }),
    };
  });
  console.log(label, JSON.stringify(state, null, 2));
  await ctx.close();
}

console.log('saved docs/research/pack-selector-{mobile,desktop}.png');
await b.close();
