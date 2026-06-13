// Browser-QA — consolidated pass over ALL P1+P2 /claw changes:
//  P1: per-card − 1 + MAX stepper; inline Open → detail page (no login wall).
//  P2: dynamic buyback % (+90 / +92), Dragon Ball chip + empty state,
//      out-of-stock tile, per-category horizontal carousel.
//  + /repacks regression (shared QtyStepper), smoke (console/network), responsive.
//
// Runs against the prod build on :4000 (backend on :9000), per repo convention
// (Chrome/preview MCP banned). Screenshots → docs/research/route-qa/qa-*.png.
//
// Run: node scripts/qa-claw-changes.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const OUT = 'docs/research/route-qa';
mkdirSync(OUT, { recursive: true });

const results = [];
const pass = (name, ok, note) => results.push({ name, ok: !!ok, note });
const consoleErrors = [];
const netFailures = [];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) =>
    consoleErrors.push('pageerror: ' + (e.message || '').slice(0, 200)),
  );
  page.on('response', (r) => {
    if (r.status() >= 400)
      netFailures.push(`${r.status()} ${r.url().slice(0, 120)}`);
  });

  // ---- /claw desktop: smoke + P1 + P2 ----
  await page.goto(`${BASE}/claw`, { waitUntil: 'networkidle', timeout: 60000 });
  await page
    .getByRole('link', { name: 'Open', exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${OUT}/qa-claw-1440.png` });

  pass(
    'P1 stepper − / + / MAX present',
    (await page.locator('button[aria-label="Decrease quantity"]').count()) >
      0 &&
      (await page.locator('button[aria-label="Increase quantity"]').count()) >
        0 &&
      (await page.getByRole('button', { name: 'Max', exact: true }).count()) >
        0,
  );
  pass(
    'P1 Open is a link (not a list real-open button)',
    (await page.getByRole('link', { name: 'Open', exact: true }).count()) > 0 &&
      (await page
        .getByRole('button', { name: 'Open', exact: true })
        .count()) === 0,
  );

  const stepper = page
    .locator('div:has(> button[aria-label="Decrease quantity"])')
    .first();
  const qty = stepper.locator('span').first();
  await page.locator('button[aria-label="Increase quantity"]').first().click();
  await page.locator('button[aria-label="Increase quantity"]').first().click();
  pass('P1 stepper increments to 3', (await qty.innerText()).trim() === '3');
  await stepper.getByRole('button', { name: 'Max', exact: true }).click();
  pass('P1 stepper MAX → 10', (await qty.innerText()).trim() === '10');

  pass(
    'P2 boosted tiers show +90% Buyback Boost',
    await page
      .getByText('+90% Buyback Boost')
      .first()
      .isVisible()
      .catch(() => false),
  );
  pass(
    'P2 Dragon Ball chip present',
    (await page
      .getByRole('button', { name: 'Dragon Ball', exact: true })
      .count()) > 0,
  );
  pass(
    'P2 category rows are horizontal carousels',
    await page.evaluate(() =>
      [...document.querySelectorAll('section > div')].some(
        (el) =>
          el.className.includes('overflow-x-auto') &&
          el.className.includes('flex'),
      ),
    ),
  );

  // scroll Pokémon carousel → premium (+92) + out-of-stock tiles in frame
  await page
    .locator('section > div.overflow-x-auto')
    .first()
    .evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    })
    .catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/qa-claw-premium-oos.png` });
  pass(
    'P2 premium tiers show +92% Buyback Boost',
    await page
      .getByText('+92% Buyback Boost')
      .first()
      .isVisible()
      .catch(() => false),
  );
  pass(
    'P2 out-of-stock tile present',
    await page
      .getByText(/Out of Stock/i)
      .first()
      .isVisible()
      .catch(() => false),
  );

  await page.getByRole('button', { name: 'Dragon Ball', exact: true }).click();
  await page.waitForTimeout(400);
  pass(
    'P2 Dragon Ball empty state',
    await page
      .getByText(/No packs available/i)
      .first()
      .isVisible()
      .catch(() => false),
  );
  await page.screenshot({ path: `${OUT}/qa-claw-dragonball.png` });

  // P1 inline Open → detail page (claw machine + free demo spin, no login wall)
  await page.getByRole('button', { name: 'All Packs', exact: true }).click();
  await page.waitForTimeout(300);
  await Promise.all([
    page.waitForURL(/\/claw\/[^/]+$/, { timeout: 15000 }),
    page.getByRole('link', { name: 'Open', exact: true }).first().click(),
  ]);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/qa-claw-detail.png` });
  const demo = await page
    .getByText(/demo spin/i)
    .first()
    .isVisible()
    .catch(() => false);
  pass(
    'P1 Open → detail (free demo spin, no login wall)',
    /\/claw\/[^/]+$/.test(page.url()) && demo,
  );

  // ---- responsive: no document-level horizontal overflow ----
  for (const w of [768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${BASE}/claw`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/qa-claw-${w}.png` });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    pass(
      `responsive ${w}px: no horizontal overflow`,
      overflow <= 2,
      `overflow=${overflow}px`,
    );
  }

  // ---- /repacks regression (shared QtyStepper) ----
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/repacks`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/qa-repacks-1440.png` });
  pass(
    'regression: /repacks stepper present',
    (await page.locator('button[aria-label="Increase quantity"]').count()) > 0,
  );

  await ctx.close();
} finally {
  await browser.close();
}

const noise = /favicon|analytics|posthog|gtag|hotjar/i;
const realErrors = consoleErrors.filter((e) => !noise.test(e));
const realNet = [...new Set(netFailures.filter((u) => !noise.test(u)))];

let ok = 0;
for (const r of results) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '  (' + r.note + ')' : ''}`,
  );
  if (r.ok) ok++;
}
console.log(`\n${ok}/${results.length} checks passed`);
console.log(
  `console errors: ${realErrors.length}${realErrors.length ? '\n  - ' + realErrors.slice(0, 8).join('\n  - ') : ''}`,
);
console.log(
  `network 4xx/5xx: ${realNet.length}${realNet.length ? '\n  - ' + realNet.slice(0, 10).join('\n  - ') : ''}`,
);
console.log(
  `screenshots → ${OUT}/qa-claw-{1440,768,375,premium-oos,dragonball,detail}.png, qa-repacks-1440.png`,
);
process.exit(ok === results.length ? 0 : 1);
