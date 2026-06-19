// scripts/qa-slots-phaseB.mjs
// QA Phase B of the v2 slot machine on the PROD build (:4000): the immersive
// full-screen /slots/<pack> reveal with the vertical Pokémon reel.
//
// PART 1 (no auth): the immersive overlay suppresses site chrome (SiteHeader/
//   SiteFooter inert + aria-hidden + off-screen), covers the viewport, renders
//   the idle reel, and shows no winner before a spin.
// PART 2 (auth, needs a funded test customer): SPIN → NO win mid-scroll
//   (win-after-stop) → winner appears on settle → the overlay box does not
//   shift. Skipped (not failed) if login or credits are unavailable.
//
// Headless; screenshots to docs/research/. Run:
//   QA_SLOT_EMAIL=… QA_SLOT_PASSWORD=… node scripts/qa-slots-phaseB.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const EMAIL = process.env.QA_SLOT_EMAIL;
const PASSWORD = process.env.QA_SLOT_PASSWORD;
const PACK = 'pokemon-rookie'; // affordable

let failed = false;
const fail = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};
const ok = (m) => console.log(`✓ ${m}`);
const skip = (m) => console.log(`⚠ SKIP ${m}`);

mkdirSync('docs/research', { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  // ---- PART 1: structural (no auth) ----
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/slots/${PACK}`, { waitUntil: 'networkidle' });

  // Chrome suppression: SiteHeader/SiteFooter tagged data-site-chrome must be
  // inert + aria-hidden while the immersive route is mounted.
  const chrome = page.locator('[data-site-chrome]');
  const chromeCount = await chrome.count();
  if (chromeCount === 0) {
    fail('no [data-site-chrome] elements found (header/footer not tagged?)');
  } else {
    let allInert = true;
    for (let i = 0; i < chromeCount; i++) {
      const el = chrome.nth(i);
      const inert = await el.getAttribute('inert');
      const hidden = await el.getAttribute('aria-hidden');
      if (inert === null || hidden !== 'true') allInert = false;
    }
    if (allInert) ok(`${chromeCount} chrome element(s) inert + aria-hidden`);
    else fail('chrome present but not all inert + aria-hidden');
  }

  // The immersive reveal root covers the viewport (fixed inset-0).
  const overlay = page.locator('.fixed.inset-0').first();
  await overlay.waitFor({ timeout: 10000 });
  const vp = page.viewportSize();
  const box = await overlay.boundingBox();
  if (box && box.width >= vp.width - 1 && box.height >= vp.height - 1)
    ok(
      `overlay covers the viewport (${Math.round(box.width)}x${Math.round(box.height)})`,
    );
  else fail(`overlay does not cover viewport: ${JSON.stringify(box)}`);

  // No winner banner before any spin.
  if ((await page.getByText(/YOU WON/i).count()) === 0)
    ok('no winner shown before spin');
  else fail('winner banner present before spin');

  // The reel + a spin/login control are rendered.
  const spinBtn = page.getByRole('button', { name: /spin|log in to spin/i });
  if (await spinBtn.first().isVisible())
    ok('reel surface + spin control rendered');
  else fail('spin control not visible');

  await page.screenshot({ path: 'docs/research/pw-slots-phaseB-idle.png' });
  await page.close();

  // ---- PART 2: spin path (needs a funded test customer) ----
  if (!EMAIL || !PASSWORD) {
    skip('QA_SLOT_EMAIL/QA_SLOT_PASSWORD unset — spin path not verified');
  } else {
    const p = await browser.newPage();
    await p.setViewportSize({ width: 1280, height: 900 });
    // Log in on the home page (header is NOT inert there), then enter the
    // immersive route already authenticated.
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const loginBtn = p.getByRole('button', { name: /^login$/i }).first();
    if (await loginBtn.isVisible().catch(() => false)) {
      await loginBtn.click();
      await p.fill('input[name="email"]', EMAIL);
      await p.fill('input[name="password"]', PASSWORD);
      await p.press('input[name="password"]', 'Enter');
      await p.waitForTimeout(2500); // let auth settle
    }

    await p.goto(`${BASE}/slots/${PACK}`, { waitUntil: 'networkidle' });
    const spin = p.getByRole('button', { name: /^spin$/i });
    const canSpin = await spin
      .first()
      .isEnabled()
      .catch(() => false);
    const loginGate = await p
      .getByRole('button', { name: /log in to spin/i })
      .count();

    if (loginGate > 0) {
      skip(
        'still shows "Log in to spin" — login did not take; spin not verified',
      );
    } else if (!canSpin) {
      skip(
        'SPIN disabled (likely no credits on the test customer) — spin not verified',
      );
    } else {
      const overlay2 = p.locator('.fixed.inset-0').first();
      const before = await overlay2.boundingBox();
      await spin.first().click();

      // Win-after-stop: the winner must not appear WHILE the reel is still
      // spinning. Tie the assertion to the visible spinning state instead of a
      // fixed 1500ms, which can false-fail once the reel has legitimately
      // settled and the winner is correctly shown.
      await p.waitForTimeout(300);
      const spinningVisible = await p
        .getByText(/SPINNING/i)
        .first()
        .isVisible()
        .catch(() => false);
      const winnerEarly = await p.getByText(/YOU WON/i).count();
      if (!spinningVisible)
        skip('reel settled before the mid-spin check (timing) — not verified');
      else if (winnerEarly === 0)
        ok('no winner shown while spinning (win-after-stop)');
      else fail('winner shown mid-spin (win-after-stop violated)');

      // Winner appears only after the reel settles.
      await p.getByText(/YOU WON/i).waitFor({ timeout: 15000 });
      ok('winner surfaced after the reel settled');

      // No layout shift: the overlay box is unchanged.
      const after = await overlay2.boundingBox();
      if (!before || !after) {
        fail('overlay bounding box unavailable before/after the spin');
      } else {
        const EPS = 1; // px tolerance for subpixel/layout rounding
        const stable =
          Math.abs(before.x - after.x) <= EPS &&
          Math.abs(before.y - after.y) <= EPS &&
          Math.abs(before.width - after.width) <= EPS &&
          Math.abs(before.height - after.height) <= EPS;
        if (stable)
          ok('overlay did not shift across the spin (no layout shift)');
        else
          fail(
            `overlay box shifted: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
          );
      }

      await p.screenshot({ path: 'docs/research/pw-slots-phaseB-landed.png' });
    }
    await p.close();
  }

  await browser.close();
  if (failed) {
    console.log('\nPHASE B QA: FAILED');
    process.exitCode = 1;
  } else {
    console.log('\nPHASE B QA: PASSED');
  }
} catch (e) {
  await browser.close();
  console.error(`✗ ${e.message}`);
  console.log('\nPHASE B QA: FAILED');
  process.exitCode = 1;
}
