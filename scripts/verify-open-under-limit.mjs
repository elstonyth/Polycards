// Verify the authenticated pack-open flow on :4000 works end-to-end with the
// backend rate limiter in place (Task 1): login, Open Pack, tap the pack,
// step the tap-through reveal, assert the won card rendered. Card art is
// served by the backend at :9000/static/* (slab-only assets since bf3416f).
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const EMAIL = 'pull-test-8654@pokenic.local';
const PW = 'pulltest2026';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1600 },
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
await page.goto(`${BASE}/claw/pokemon-mythic`, { waitUntil: 'networkidle' });

await page
  .getByRole('button', { name: /Log in to open/i })
  .first()
  .click();
const dialog = page.getByRole('dialog');
await dialog.waitFor({ state: 'visible', timeout: 8000 });
await dialog.locator('input[name="email"]').fill(EMAIL);
await dialog.locator('input[name="password"]').fill(PW);
await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
await dialog.waitFor({ state: 'detached', timeout: 12000 });

const openBtn = page.getByRole('button', { name: /Open Pack/i }).first();
await openBtn.waitFor({ state: 'visible', timeout: 12000 });
await openBtn.click();
await page.waitForTimeout(1200);

const overlayUp = await page
  .getByText(/Shuffle|Drag to spin/i)
  .first()
  .isVisible()
  .catch(() => false);
console.log('overlay (pack carousel) shown:', overlayUp);

// Tap the centre pack, then step the reveal through to the card.
const cx = 720;
await page.mouse.click(cx, 750); // packs → slab
await page.waitForTimeout(700);
for (const step of ['slab→metadata', 'metadata→pull', 'pull→card']) {
  await page.mouse.click(cx, 750);
  await page.waitForTimeout(400);
  void step;
}
await page.waitForTimeout(800);

const continueBtn = await page
  .getByRole('button', { name: /^Continue$/ })
  .first()
  .isVisible()
  .catch(() => false);
const cardImg = await page.evaluate(() =>
  [...document.querySelectorAll('img')].some(
    (i) => i.src.includes('/static/') && i.naturalWidth > 50,
  ),
);
const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const rateLimited = /too fast/i.test(bodyText);
const failed = /could not open/i.test(bodyText);

console.log('reached card stage (Continue visible):', continueBtn);
console.log('won card image rendered:', cardImg);
console.log('rate-limited copy shown:', rateLimited);
console.log('failure copy shown:', failed);
if (errors.length) console.log('console errors:', errors.slice(0, 3));
console.log(
  'VERDICT:',
  continueBtn && cardImg && !failed
    ? 'PASS — authenticated open works under the limit'
    : 'FAIL',
);
await page.screenshot({
  path: 'docs/research/rl-open-under-limit.png',
  fullPage: false,
});
await browser.close();
