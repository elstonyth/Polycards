// Phase 5b — /claw/[slug] open-pack wiring.
// Verifies the storefront detail page reflects the live backend ledger:
//   - Recent Pulls renders the live feed (GET /store/pulls/recent), NOT the
//     static CARD_POOL mock: row count + first card name match the API exactly.
//   - The "Open Pack" footer button is auth-gated: logged-out it reads
//     "Log in to open" (no anonymous opens).
//   - 5a regression: Pull Odds still shows the 4 seeded rarities (no Legendary).
// Screenshots -> docs/research/phase5.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const API = 'http://localhost:9000';
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const OUT = 'docs/research/phase5';
mkdirSync(OUT, { recursive: true });

const r = {};

// Source of truth: the live ledger the page should be rendering.
const apiRes = await fetch(`${API}/store/pulls/recent`, {
  headers: { 'x-publishable-api-key': PK },
});
const apiJson = await apiRes.json();
const apiPulls = Array.isArray(apiJson.pulls) ? apiJson.pulls : [];
r.apiPullCount = apiPulls.length;
r.apiFirstName = apiPulls[0]?.name ?? null;
r.apiLeaksCustomerId = apiPulls.some((p) => 'customer_id' in p); // must be false

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1600 },
  reducedMotion: 'reduce', // <Reveal> renders below-fold content immediately
});
const page = await ctx.newPage();
await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// Recent Pulls — the live feed.
const recentSection = page
  .locator('section', {
    has: page.getByRole('heading', { name: /Recent Pulls/i }),
  })
  .first();
const recentRows = await recentSection
  .locator('li')
  .allTextContents()
  .then((a) => a.map((s) => s.replace(/\s+/g, ' ').trim()));
r.domRecentRowCount = recentRows.length;
r.domFirstRow = recentRows[0] ?? null;
r.domShowsEmptyState = recentRows.some((t) => /No pulls yet/i.test(t));

// Pull Odds (5a regression) — 4 rarities, no Legendary.
const oddsSection = page
  .locator('section', {
    has: page.getByRole('heading', { name: /Pull Odds/i }),
  })
  .first();
const oddsRows = await oddsSection.locator('li').allTextContents();
r.rarityCount = oddsRows.length;
r.hasLegendaryRow = oddsRows.some((t) => /Legendary/i.test(t));

// Open Pack footer button — auth-gated (logged out => "Log in to open").
const openBtnText = await page
  .getByRole('button', { name: /Log in to open|Open Pack|Opening/i })
  .first()
  .textContent();
r.openButtonText = (openBtnText ?? '').replace(/\s+/g, ' ').trim();
r.openButtonGated = /Log in to open/i.test(r.openButtonText);

// Verdicts.
const recentWired =
  r.apiPullCount > 0 &&
  !r.domShowsEmptyState &&
  r.domRecentRowCount === r.apiPullCount &&
  r.apiFirstName != null &&
  (r.domFirstRow ?? '').includes(r.apiFirstName);

r.verdict =
  recentWired &&
  r.openButtonGated &&
  r.rarityCount === 4 &&
  !r.hasLegendaryRow &&
  !r.apiLeaksCustomerId
    ? 'PASS (5b backend-wired)'
    : 'FAIL (mock fallback / not gated / odds regressed / PII leak)';

await page.screenshot({
  path: `${OUT}/02-open-pokemon-mythic.png`,
  fullPage: true,
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
