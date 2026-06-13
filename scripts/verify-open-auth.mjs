// Phase 5b — AUTHENTICATED open->reveal browser pass (closes the loop the
// logged-out + reduced-motion capture couldn't: the real card injection at
// WIN_INDEX + animated land + the optimistic Recent Pulls prepend).
//
// Runs with motion ON so runReveal -> displayStrip[WIN_INDEX] -> transition ->
// setWon(displayStrip[WIN_INDEX]) is exercised end to end. Drives the real auth
// modal with the dev test customer, clicks Open Pack, asserts a real won card
// name shows in the "You pulled" panel and is prepended ("just now") to Recent
// Pulls. Screenshot -> docs/research/phase5.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const EMAIL = 'pull-test-8654@pokenic.local';
const PW = 'pulltest2026';
const OUT = 'docs/research/phase5';
mkdirSync(OUT, { recursive: true });

const r = {};
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1600 },
});
const page = await ctx.newPage();
await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: 'networkidle' });

// 1. Logged-out: footer button gates to login. Click it -> auth modal opens.
await page
  .getByRole('button', { name: /Log in to open/i })
  .first()
  .click();
const dialog = page.getByRole('dialog');
await dialog.waitFor({ state: 'visible', timeout: 8000 });

// 2. Log in as the dev test customer.
await dialog.locator('input[name="email"]').fill(EMAIL);
await dialog.locator('input[name="password"]').fill(PW);
await dialog.getByRole('button', { name: 'Log in', exact: true }).click();

// Modal closes on successful login (onSuccess) — that's the success signal.
await dialog.waitFor({ state: 'detached', timeout: 12000 });

// 3. After login the footer button flips to the real "Open Pack" (its name also
//    includes the points/price badges, so match by substring, not exact).
const openBtn = page.getByRole('button', { name: /Open Pack/i }).first();
await openBtn.waitFor({ state: 'visible', timeout: 12000 });
r.buttonAfterLogin =
  (await openBtn.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
r.buttonFlipped =
  /Open Pack/i.test(r.buttonAfterLogin) && !/Log in/i.test(r.buttonAfterLogin);

// 4. Open the pack — exercise the full reveal (motion on).
await openBtn.click();
const wonPanel = page.locator('div:has(> p:text-is("You pulled"))').first();
await wonPanel.waitFor({ state: 'visible', timeout: 20000 });

// The won card name is the <p> right after the "You pulled" caption.
const wonName = await page
  .locator('p:text-is("You pulled")')
  .locator('xpath=following-sibling::p[1]')
  .first()
  .textContent();
r.revealWonName = (wonName ?? '').trim();
r.revealHasRealCard = r.revealWonName.length > 4;

// 5. The won card is optimistically prepended to Recent Pulls ("just now").
const recentSection = page
  .locator('section', {
    has: page.getByRole('heading', { name: /Recent Pulls/i }),
  })
  .first();
await recentSection.scrollIntoViewIfNeeded();
const firstRecent =
  (await recentSection.locator('li').first().textContent())
    ?.replace(/\s+/g, ' ')
    .trim() ?? '';
r.firstRecentRow = firstRecent;
r.prependedWonCard =
  r.revealWonName.length > 0 &&
  firstRecent.includes(r.revealWonName) &&
  /just now/i.test(firstRecent);

r.verdict =
  r.buttonFlipped && r.revealHasRealCard && r.prependedWonCard
    ? 'PASS (authenticated open->reveal->feed)'
    : 'FAIL';

await page.screenshot({
  path: `${OUT}/03-open-authenticated.png`,
  fullPage: true,
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
