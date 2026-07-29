// scripts/qa-display-changes.mjs
// QA for the 2026-07-29 storefront display changes:
//   1. Home: How It Rips section gone.
//   2. Home: top chase == the featured pack's highest-value pool card.
//   3. /slots/bronze-pack: "Cards in this pack" = Mythical+ teaser (<=6 tiles,
//      NO tier headers), expandable to tier shelves with only Mythical+ labels.
//      The expand half only runs when a pack seeds >6 Mythical+ cards; it is
//      reported as SKIP (never a pass) otherwise.
//   4. /slots/bronze-pack: odds panel shows "Card value range", never
//      "Overall win rate".
//   5. /slots/bronze-pack/spin?demo=1: odds sheet shows the same range row.
// Usage: node scripts/qa-display-changes.mjs   (server on :4120 or $PW_BASE)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.PW_BASE ?? 'http://localhost:4120';
const BACKEND = process.env.PW_BACKEND ?? 'http://localhost:9000';
const TOP_RARITIES = ['Immortal', 'Legendary', 'Mythical'];
const RANGE_RE = /RM [\d,.]+ – RM [\d,.]+/;
mkdirSync('docs/research', { recursive: true });

// The storefront's own PUBLIC publishable key (.env.local NEXT_PUBLIC_*) — only
// the backend-pool fallback needs it, so read it LAZILY and repo-relative: an
// eager cwd-relative read threw ENOENT before a single assertion ran whenever
// the script was invoked from another cwd or a fresh checkout.
const publishableKey = () => {
  if (process.env.PW_PK) return process.env.PW_PK;
  let env;
  try {
    env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    throw new Error(
      'backend-pool fallback needs a publishable key, but .env.local is unreadable — set PW_PK=pk_… and re-run',
    );
  }
  const key = env.match(/pk_[a-z0-9]+/)?.[0];
  if (!key)
    throw new Error('no pk_… key in .env.local — set PW_PK=pk_… instead');
  return key;
};

let failures = 0;
let skips = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!ok) failures += 1;
};
// A check that could NOT run against this data set. Counted and reported so a
// green exit can never be read as "everything was verified".
const skip = (msg) => {
  console.log(`SKIP: ${msg}`);
  skips += 1;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  // Cookie banner is role=dialog too — reject it once so screenshots and
  // dialog-scoped selectors stay clean (privacy default: reject).
  const rejectConsent = async () => {
    const reject = page.getByRole('button', { name: 'Reject' });
    await reject.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await reject.isVisible().catch(() => false)) await reject.click();
  };

  // ---- 1 + 2a: home ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await rejectConsent();

  const bodyText = await page.locator('body').innerText();
  check(!/HOW IT RIPS/i.test(bodyText), 'home has no "How It Rips" text');

  // Hero headline = the featured pack's top chase value.
  const heroChase = (
    await page.locator('p.font-heading.text-chase').first().innerText()
  ).trim();
  check(
    /^RM [\d,.]+$/.test(heroChase),
    `hero top chase is an RM value (${heroChase})`,
  );
  // "Top chase: {card} · {pack}" — take the pack name after the interpunct.
  const chaseLine = (
    await page
      .locator('p', { hasText: /^Top chase:/ })
      .first()
      .innerText()
  ).trim();
  const featuredPackName = chaseLine.split('·').pop().trim();
  check(
    featuredPackName.length > 0,
    `featured pack name parsed (${featuredPackName})`,
  );
  await page.screenshot({
    path: 'docs/research/qa-display-home.png',
    fullPage: false,
  });

  // ---- 2b: featured pack detail shows the same RM as its top card ----
  // Home rows all route to /slots (routing rule), so resolve the slug there.
  await page.goto(`${BASE}/slots`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  const featuredHref = await page
    .locator(`a[href^="/slots/"]`, { hasText: featuredPackName })
    .first()
    .getAttribute('href');
  check(
    !!featuredHref,
    `catalog link found for "${featuredPackName}" (${featuredHref})`,
  );

  await page.goto(`${BASE}${featuredHref}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  // The hero chase == the featured pack's highest-value pool card, over the
  // FULL pool. Only two surfaces read the full pool: the odds panel's value-
  // range row and the store endpoint itself. The "Cards in this pack" teaser is
  // NOT a valid oracle — it is pre-filtered to Mythical+, so any cheaper-tier
  // card that out-prices every Mythical+ makes its first tile legitimately
  // differ from the hero chase (comparing them fails on CORRECT code).
  const oddsSection = page.locator('section', {
    has: page.locator('h2', { hasText: 'Pull Odds (by rarity)' }),
  });
  // The range row is the first <li> only when something in the pool is priced;
  // otherwise the first row is a rarity row and would never end with an RM value.
  const rangeRow =
    (await oddsSection.count()) > 0
      ? (await oddsSection.locator('ul > li').first().innerText()).trim()
      : '';
  if (/^Card value range/.test(rangeRow)) {
    check(
      rangeRow.endsWith(heroChase),
      `featured pack value-range max matches hero chase "${heroChase}" (${rangeRow.replace(/\s+/g, ' ')})`,
    );
  } else {
    const slug = featuredHref.replace(/^\/slots\//, '').replace(/\?.*$/, '');
    const res = await fetch(`${BACKEND}/store/packs/${slug}`, {
      headers: { 'x-publishable-api-key': publishableKey() },
    });
    const { odds = [] } = await res.json();
    const poolMax = Math.max(
      0,
      ...odds.map((o) => o.marketPriceMyr ?? 0).filter((v) => v > 0),
    );
    const heroNum = Number(heroChase.replace(/[^\d.]/g, ''));
    check(
      poolMax > 0 && Math.abs(poolMax - heroNum) < 0.005,
      `hero chase ${heroNum} equals store pool max ${poolMax} for ${slug} (no value-range row on page)`,
    );
  }
  await page.screenshot({ path: 'docs/research/qa-display-featured-pack.png' });

  // ---- 3: bronze-pack cards teaser ----
  await page.goto(`${BASE}/slots/bronze-pack`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  const bronzeSection = page.locator('section', {
    has: page.locator('h2', { hasText: 'Cards in this pack' }),
  });
  const tiles = bronzeSection.locator('button[aria-label^="View details for"]');
  const tileCount = await tiles.count();
  check(
    tileCount > 0 && tileCount <= 6,
    `teaser renders ${tileCount} tiles (<= 6)`,
  );

  // Tier labels only exist in the EXPANDED state — PoolByRarity's collapsed
  // teaser is one flat rail with no <h3> at all (CardTile renders the card name
  // as a <span>, so nothing else contributes an h3 here). The collapsed
  // contract is therefore "zero tier headers", NOT "every header is Mythical+"
  // — the latter is vacuously true over an empty list and can never fail.
  const tierLabels = () => bronzeSection.locator('h3').allInnerTexts();
  const collapsedLabels = await tierLabels();
  check(
    collapsedLabels.length === 0,
    `collapsed: no tier headers (${collapsedLabels.length} found)`,
  );
  await page.screenshot({ path: 'docs/research/qa-display-bronze-cards.png' });

  // Locate the toggle by aria-controls, NOT by its text: the label flips to
  // "Show less" on expand, so a text-filtered locator would resolve to zero
  // elements afterwards and the post-click getAttribute would sit out the full
  // timeout and throw, instead of reporting a clean FAIL. This also exercises
  // the aria-controls wiring itself.
  const toggle = bronzeSection.locator(
    'button[aria-controls="pack-cards-pool"]',
  );
  if (await toggle.isVisible().catch(() => false)) {
    check(
      /^Show all \d+ rare cards$/.test((await toggle.innerText()).trim()),
      `collapsed: toggle label names the rare subset ("${(await toggle.innerText()).trim()}")`,
    );
    check(
      (await toggle.getAttribute('aria-expanded')) === 'false',
      'collapsed: toggle reports aria-expanded="false"',
    );
    await toggle.click();
    const expandedLabels = await tierLabels();
    check(
      expandedLabels.length > 0,
      `expanded: ${expandedLabels.length} tier header(s) render`,
    );
    check(
      expandedLabels.every((l) => TOP_RARITIES.includes(l.trim())),
      `expanded: every tier label is Mythical+ (${expandedLabels.join(', ')})`,
    );
    check(
      (await toggle.getAttribute('aria-expanded')) === 'true',
      'expanded: toggle reports aria-expanded="true"',
    );
    check(
      (await toggle.innerText()).trim() === 'Show less',
      `expanded: toggle label becomes "Show less" ("${(await toggle.innerText()).trim()}")`,
    );
    await page.screenshot({
      path: 'docs/research/qa-display-bronze-expanded.png',
    });
  } else {
    // NOT a pass: the expand interaction is the headline change of this PR and
    // no local pack seeds >6 Mythical+ cards, so it goes unverified here. The
    // collapsed/expanded contract is unit-tested only if a component harness
    // exists; today it does not (see the PR discussion).
    skip(
      'expand path: bronze-pack has <= 6 Mythical+ cards, so no "Show all" toggle renders — tier shelves, aria-expanded and the "Show less" label were NOT exercised',
    );
  }

  // ---- 4: bronze-pack odds panel ----
  const pageText = await page.locator('body').innerText();
  check(
    !pageText.includes('Overall win rate'),
    'no "Overall win rate" anywhere on the pack page',
  );
  const oddsPanel = page.locator('section', {
    has: page.locator('h2', { hasText: 'Pull Odds (by rarity)' }),
  });
  const firstRow = (
    await oddsPanel.locator('ul > li').first().innerText()
  ).trim();
  check(
    /^Card value range/.test(firstRow),
    `odds first row is "Card value range" (${firstRow.replace(/\s+/g, ' ')})`,
  );
  check(
    RANGE_RE.test(firstRow),
    `odds range matches RM min – max (${firstRow.replace(/\s+/g, ' ')})`,
  );
  await oddsPanel
    .locator('h2', { hasText: 'Pull Odds (by rarity)' })
    .scrollIntoViewIfNeeded();
  // Let the <Reveal> fade-up finish before shooting, or the panel reads blank.
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'docs/research/qa-display-bronze-odds.png' });

  // ---- 5: demo spin odds sheet ----
  await page.goto(`${BASE}/slots/bronze-pack/spin?demo=1`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await rejectConsent();
  // Reel readiness: the sr-only meter idiom — probe aria-busy=false, never the
  // animated odometer.
  await page
    .locator('[aria-busy="false"]')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});
  await page.getByRole('button', { name: 'Odds' }).click();
  const sheet = page.locator('[role="dialog"][aria-modal="true"]');
  await sheet.waitFor({ timeout: 5000 });
  const sheetRow = (await sheet.locator('ul > li').first().innerText()).trim();
  check(
    /^Card value range/.test(sheetRow),
    `demo odds sheet first row is "Card value range" (${sheetRow.replace(/\s+/g, ' ')})`,
  );
  check(RANGE_RE.test(sheetRow), `demo odds sheet range matches RM min – max`);
  const sheetText = await sheet.innerText();
  check(
    !sheetText.includes('Overall win rate'),
    'demo odds sheet has no "Overall win rate"',
  );
  await page.screenshot({
    path: 'docs/research/qa-display-demo-odds-sheet.png',
  });
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED, ${skips} skipped`);
  process.exit(1);
}
console.log(
  skips > 0
    ? `\nDisplay-change QA: every assertion that RAN passed, but ${skips} check(s) were SKIPPED and are unverified — see the SKIP line(s) above.`
    : '\nAll display-change QA assertions passed; nothing skipped.',
);
