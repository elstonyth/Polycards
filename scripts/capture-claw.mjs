// Phase 4 — /claw pack listing wired to the backend (GET /store/packs).
// Verifies: grid renders backend packs; per-category sections + counts; the
// OpenPacksSection deep links (/claw?category=<key>) preselect the right tab
// (incl. the join-key risk cases: one-piece, yugioh). Screenshots → docs/research/phase4.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/phase4';
mkdirSync(OUT, { recursive: true });

const r = {};
const browser = await chromium.launch();
// reducedMotion: 'reduce' makes <Reveal> render content visible immediately, so
// the full-page screenshot proves every section renders (not just above-fold).
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await ctx.newPage();

const activeTab = () =>
  page
    .locator('button[aria-pressed="true"]')
    .first()
    .textContent()
    .then((t) => (t ?? '').trim())
    .catch(() => '<none>');

// 1) /claw — full catalog from the backend.
await page.goto(`${BASE}/claw`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
r.claw_sectionHeadings = await page
  .locator('section h2')
  .allTextContents()
  .then((a) => a.map((s) => s.trim()));
r.claw_openButtons = await page
  .getByRole('link', { name: 'Open', exact: true })
  .count();
r.claw_activeTab = await activeTab();
await page.screenshot({ path: `${OUT}/01-claw-all.png`, fullPage: true });

// 2) Deep link → One Piece (label "One Piece" → key "one-piece").
await page.goto(`${BASE}/claw?category=one-piece`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(400);
r.onepiece_activeTab = await activeTab();
r.onepiece_sections = await page
  .locator('section h2')
  .allTextContents()
  .then((a) => a.map((s) => s.trim()));
r.onepiece_openButtons = await page
  .getByRole('link', { name: 'Open', exact: true })
  .count();
await page.screenshot({ path: `${OUT}/02-claw-onepiece.png` });

// 3) Deep link → Yu-Gi-Oh! (label "Yu-Gi-Oh!" → key "yugioh") — the second
//    join-key risk case the review flagged.
await page.goto(`${BASE}/claw?category=yugioh`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
r.yugioh_activeTab = await activeTab();
r.yugioh_sections = await page
  .locator('section h2')
  .allTextContents()
  .then((a) => a.map((s) => s.trim()));

// 4) Unknown category → falls back to All Packs (no crash).
await page.goto(`${BASE}/claw?category=does-not-exist`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(300);
r.unknown_activeTab = await activeTab();

// 5) Home OpenPacksSection tiles route into /claw?category=<key>.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
r.home_openPacksHrefs = await page
  .locator('a[href^="/claw?category="]')
  .evaluateAll((els) => els.map((e) => e.getAttribute('href')));

// 6) Click-through: an "Open" button → /claw/<slug> detail renders. The detail
//    page still reads packs-data.ts (Phase-5 deferred), so this only resolves if
//    the backend slug === packs-data id — the core CTA's join key.
await page.goto(`${BASE}/claw`, { waitUntil: 'networkidle' });
const firstOpen = page.getByRole('link', { name: 'Open', exact: true }).first();
r.detail_hrefFromList = await firstOpen.getAttribute('href');
await firstOpen.click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
r.detail_url = page.url().replace(BASE, '');
r.detail_isNextNotFound = await page
  .getByText('This page could not be found', { exact: false })
  .first()
  .isVisible()
  .catch(() => false);
r.detail_heading = await page
  .locator('h1, h2')
  .first()
  .textContent()
  .then((t) => (t ?? '').trim())
  .catch(() => '<none>');
await page.screenshot({ path: `${OUT}/03-claw-detail.png`, fullPage: true });

console.log(JSON.stringify(r, null, 2));
await browser.close();
