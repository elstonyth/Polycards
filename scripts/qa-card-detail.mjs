// scripts/qa-card-detail.mjs
// End-to-end QA for the card grid + detail overlay on the :4000 PROD build.
// Usage: node scripts/qa-card-detail.mjs [pack-slug]   (default pokemon-black)
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';

const SLUG = process.argv[2] || 'pokemon-black';
const BASE = process.env.BASE || 'http://127.0.0.1:4000';
mkdirSync('docs/research', { recursive: true });

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

const browser = await chromium.launch();
try {
  // @axe-core/playwright requires a page from an explicit context.
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/slots/${SLUG}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });

  // The cookie-consent banner is ALSO role=dialog — dismiss it so dialog
  // selectors (scoped to the overlay via [aria-modal]) and screenshots stay
  // clean.
  // isVisible() ignores { timeout } — an explicit waitFor makes the 3s
  // banner-appearance wait real instead of an immediate check.
  const consent = page.getByRole('button', { name: 'Accept' });
  await consent.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await consent.isVisible().catch(() => false)) {
    await consent.click();
  }

  // 1) grid: at least one tile with name + "est." price
  const tile = page
    .getByRole('button', { name: /^View details for /i })
    .first();
  await tile.waitFor({ timeout: 15000 });
  const estCount = await page.getByText('est.').count();
  if (estCount === 0) fail('no "est." price labels on the pack grid');
  await page.screenshot({
    path: 'docs/research/qa-card-detail-grid.png',
    fullPage: true,
  });

  // 2) overlay opens instantly + URL becomes /card/<handle>
  await tile.click();
  // [aria-modal="true"] scopes to the card overlay (the cookie banner is a
  // non-modal role=dialog).
  const dialog = page.locator('[role=dialog][aria-modal="true"]');
  await dialog.waitFor({ timeout: 5000 });
  if (!/\/card\//.test(page.url())) fail(`URL did not change: ${page.url()}`);
  await page.waitForTimeout(1500); // let useCardPrice hydrate set/grade/sparkline
  await page.screenshot({ path: 'docs/research/qa-card-detail-overlay.png' });
  const deepLink = page.url();

  // 2b) axe pass scoped to the open overlay (whole-page axe false-positives
  // mid-Reveal are a known trap — scope to the dialog only).
  const axe = await new AxeBuilder({ page })
    .include('[role=dialog][aria-modal="true"]')
    .analyze();
  if (axe.violations.length > 0) {
    fail(
      `axe violations in overlay: ${axe.violations.map((v) => v.id).join(', ')}`,
    );
  }

  // 3) Esc closes + URL restored to the pack page
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  if (!page.url().includes(`/slots/${SLUG}`)) {
    fail(`URL not restored after Esc: ${page.url()}`);
  }

  // 4) browser Back also closes (open again, then go back)
  await tile.click();
  await dialog.waitFor({ timeout: 5000 });
  await page.goBack();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });

  // 5) deep link renders the full server page (no overlay chrome, real title)
  await page.goto(deepLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('h1', { timeout: 10000 });
  const title = await page.title();
  if (!/Pokenic/.test(title)) fail(`deep-link title suspicious: ${title}`);
  if ((await page.locator('[role=dialog][aria-modal="true"]').count()) > 0) {
    fail('deep link rendered the overlay instead of the page');
  }
  await page.screenshot({
    path: 'docs/research/qa-card-detail-page.png',
    fullPage: true,
  });

  console.log(process.exitCode ? 'DONE with failures' : 'PASS');
} finally {
  await browser.close();
}
