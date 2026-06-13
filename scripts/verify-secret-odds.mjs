// Phase 6a — SECRET-ODDS DECOUPLING no-leak gate.
//
// Proves the customer-facing odds are fully decoupled from the secret per-card
// win rates (`weight`), on BOTH layers:
//   1. API layer  — GET /store/packs/:slug returns NO `weight` field per card.
//   2. Storefront — /claw/[slug] "Pull Odds" renders the STATIC published ODDS
//      (5 tiers incl. Legendary 0.5%), NOT the backend weight-derived odds
//      (which had only the 4 seeded tiers, no Legendary). Meanwhile Top Hits
//      stays backend-derived ($39.80 real values) — so the contrast proves the
//      decoupling is surgical (odds static, card data still live), not a blanket
//      mock fallback.
// Screenshots -> docs/research/phase6.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/phase6';
mkdirSync(OUT, { recursive: true });

// Publishable key for the direct API probe.
const PK = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY='))
  ?.split('=')[1]
  ?.replace(/['"]/g, '')
  .trim();

const r = {};

// --- Layer 1: API response must not contain `weight` ---
const apiRes = await fetch('http://localhost:9000/store/packs/pokemon-mythic', {
  headers: { 'x-publishable-api-key': PK },
});
const apiJson = await apiRes.json();
const oddsEntries = apiJson.odds ?? [];
r.apiOddsCount = oddsEntries.length;
r.apiEntryKeys = oddsEntries[0] ? Object.keys(oddsEntries[0]) : [];
r.apiHasWeight = oddsEntries.some((e) => 'weight' in e);

// --- Layer 2: storefront Pull Odds = static published ODDS ---
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1400 },
  reducedMotion: 'reduce', // <Reveal> renders immediately so below-fold is captured
});
const page = await ctx.newPage();
await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const pullOdds = page
  .locator('section', {
    has: page.getByRole('heading', { name: /Pull Odds/i }),
  })
  .first();
r.rarityRows = await pullOdds
  .locator('li')
  .allTextContents()
  .then((a) => a.map((s) => s.replace(/\s+/g, ' ').trim()));
r.rarityCount = r.rarityRows.length;
r.hasLegendaryRow = r.rarityRows.some((t) => /Legendary/i.test(t));
// Static ODDS percentages, in order.
const STATIC_PCTS = ['0.5%', '4.5%', '15%', '30%', '50%'];
r.matchesStaticOdds =
  r.rarityCount === 5 &&
  STATIC_PCTS.every((p, i) => r.rarityRows[i]?.includes(p));

const topHits = page
  .locator('section', { has: page.getByRole('heading', { name: /Top Hits/i }) })
  .first();
r.topHitValues = await topHits
  .locator('p.text-center')
  .allTextContents()
  .then((a) => a.map((s) => s.trim()));
r.backendTopValuePresent = r.topHitValues.some((v) => /\$39\.80/.test(v));
r.mockTopValuePresent = r.topHitValues.some((v) => /\$912\.00/.test(v));

await page.screenshot({
  path: `${OUT}/01-secret-odds-pokemon-mythic.png`,
  fullPage: true,
});
await browser.close();

r.verdict =
  !r.apiHasWeight &&
  r.matchesStaticOdds &&
  r.hasLegendaryRow &&
  r.backendTopValuePresent &&
  !r.mockTopValuePresent
    ? 'PASS (no-leak: API has no weight, Pull Odds static, Top Hits still backend)'
    : 'FAIL';

console.log(JSON.stringify(r, null, 2));
