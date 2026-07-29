// scripts/qa-display-changes.mjs
// QA for the 2026-07-29 storefront display changes:
//   1. Home: How It Rips section gone.
//   2. Home: top chase == the featured pack's highest-value pool card.
//   3. /slots/bronze-pack: "Cards in this pack" = Mythical+ teaser (<=6 tiles),
//      expandable to tier shelves with only Mythical+ labels.
//   4. /slots/bronze-pack: odds panel shows "Card value range", never
//      "Overall win rate".
//   5. /slots/bronze-pack/spin?demo=1: odds sheet shows the same range row.
// Usage: node scripts/qa-display-changes.mjs   (server on :4120 or $PW_BASE)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.PW_BASE ?? 'http://localhost:4120';
const BACKEND = process.env.PW_BACKEND ?? 'http://localhost:9000';
// The storefront's own PUBLIC publishable key (.env.local NEXT_PUBLIC_*) — for
// the pool fallback check when a pack renders neither odds nor cards surface.
const PK =
  process.env.PW_PK ??
  readFileSync('.env.local', 'utf8').match(/pk_[a-z0-9]+/)?.[0];
const TOP_RARITIES = ['Immortal', 'Legendary', 'Mythical'];
const RANGE_RE = /RM [\d,.]+ – RM [\d,.]+/;
mkdirSync('docs/research', { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!ok) failures += 1;
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
  // The hero chase == the featured pack's highest-value pool card. Prefer the
  // on-page surfaces (teaser first tile / odds-range max); when the pack
  // publishes no odds AND has no Mythical+ cards (both surfaces hidden),
  // fall back to the store pool itself — same endpoint the page consumed.
  const cardsSection = page.locator('section', {
    has: page.locator('h2', { hasText: 'Cards in this pack' }),
  });
  const oddsSection = page.locator('section', {
    has: page.locator('h2', { hasText: 'Pull Odds (by rarity)' }),
  });
  if ((await cardsSection.count()) > 0) {
    const firstTileValue = (
      await cardsSection
        .locator('button[aria-label^="View details for"]')
        .first()
        .locator('span.whitespace-nowrap')
        .innerText()
    ).trim();
    check(
      firstTileValue.startsWith(heroChase),
      `featured pack top card value "${firstTileValue}" matches hero chase "${heroChase}"`,
    );
  } else if ((await oddsSection.count()) > 0) {
    const row = (
      await oddsSection.locator('ul > li').first().innerText()
    ).trim();
    check(
      row.endsWith(heroChase),
      `featured pack value-range max matches hero chase "${heroChase}" (${row.replace(/\s+/g, ' ')})`,
    );
  } else {
    const slug = featuredHref.replace(/^\/slots\//, '').replace(/\?.*$/, '');
    const res = await fetch(`${BACKEND}/store/packs/${slug}`, {
      headers: { 'x-publishable-api-key': PK },
    });
    const { odds = [] } = await res.json();
    const poolMax = Math.max(
      0,
      ...odds.map((o) => o.marketPriceMyr ?? 0).filter((v) => v > 0),
    );
    const heroNum = Number(heroChase.replace(/[^\d.]/g, ''));
    check(
      poolMax > 0 && Math.abs(poolMax - heroNum) < 0.005,
      `hero chase ${heroNum} equals store pool max ${poolMax} for ${slug} (no odds/cards surface on page)`,
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

  const labelsOk = async () => {
    const labels = await bronzeSection.locator('h3').allInnerTexts();
    return labels.every((l) => TOP_RARITIES.includes(l.trim()));
  };
  check(await labelsOk(), 'collapsed: every tier label is Mythical+');
  await page.screenshot({ path: 'docs/research/qa-display-bronze-cards.png' });

  const showAll = bronzeSection.locator('button', {
    hasText: /^Show all \d+ cards$/,
  });
  if (await showAll.isVisible().catch(() => false)) {
    await showAll.click();
    const headerCount = await bronzeSection.locator('h3').count();
    check(headerCount > 0, `expanded: ${headerCount} tier header(s) render`);
    check(
      await labelsOk(),
      'expanded: no Common/Uncommon/Rare label in section',
    );
    await page.screenshot({
      path: 'docs/research/qa-display-bronze-expanded.png',
    });
  } else {
    console.log(
      'INFO: no "Show all" button (pool <= 6 Mythical+ cards) — teaser is the whole set',
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
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll display-change QA assertions passed.');
