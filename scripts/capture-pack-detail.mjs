// Phase 5a — /claw/[slug] detail wired to the backend gacha pool.
// Verifies: Top Hits + Pull Odds render REAL backend data (GET /store/packs/:slug),
// not the static mock pools. Discriminators:
//   - Pull Odds shows the 4 seeded rarities (Common/Uncommon/Rare/Epic), NOT the
//     mock 5 (which includes Legendary).
//   - Top Hits values are the real card market values (~$39.80), NOT the mock
//     CARD_POOL values (e.g. $912.00).
// Screenshots -> docs/research/phase5.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/phase5';
mkdirSync(OUT, { recursive: true });

const r = {};
const browser = await chromium.launch();
// reducedMotion: 'reduce' => <Reveal> renders content immediately, so the
// below-the-fold Pull Odds panel is captured in the full-page screenshot.
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1400 },
  reducedMotion: 'reduce',
});
const page = await ctx.newPage();

await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// Pull Odds (by rarity) — read the rows under the "Pull Odds" heading.
const pullOddsSection = page
  .locator('section', {
    has: page.getByRole('heading', { name: /Pull Odds/i }),
  })
  .first();
r.rarityRows = await pullOddsSection
  .locator('li')
  .allTextContents()
  .then((a) => a.map((s) => s.replace(/\s+/g, ' ').trim()));
r.rarityCount = r.rarityRows.length;

// Top Hits — the value labels under each card.
const topHitsSection = page
  .locator('section', { has: page.getByRole('heading', { name: /Top Hits/i }) })
  .first();
r.topHitValues = await topHitsSection
  .locator('p.text-center')
  .allTextContents()
  .then((a) => a.map((s) => s.trim()));

// Discriminators. NOTE: `rarityCount === 4 && !hasLegendaryRow` is coupled to
// the current seed pool (16 cards, no Legendary). Adding a Legendary card to
// CARD_PRODUCTS would make this a false FAIL — update the expectation then.
r.hasLegendaryRow = r.rarityRows.some((t) => /Legendary/i.test(t));
r.backendTopValuePresent = r.topHitValues.some((v) => /\$39\.80/.test(v));
r.mockTopValuePresent = r.topHitValues.some((v) => /\$912\.00/.test(v));
r.verdict =
  r.rarityCount === 4 &&
  !r.hasLegendaryRow &&
  r.backendTopValuePresent &&
  !r.mockTopValuePresent
    ? 'PASS (backend-wired)'
    : 'FAIL (mock fallback or wrong data)';

await page.screenshot({
  path: `${OUT}/01-detail-pokemon-mythic.png`,
  fullPage: true,
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
