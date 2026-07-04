// scripts/qa-vault-room.mjs
// Visual QA for the Vault Room slot redesign. Requires the standalone server
// on :4000 (npm run build; pwsh scripts/serve-standalone.ps1 -Port 4000) and,
// for spin states, backend on :9000 + PW_CUSTOMER_EMAIL/PW_CUSTOMER_PASSWORD.
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE ?? 'http://localhost:4000';
const OUT = process.env.QA_OUT_DIR ?? 'docs/research';
const SLUG = process.env.QA_PACK_SLUG ?? ''; // required: an existing pack slug
const EMAIL = process.env.PW_CUSTOMER_EMAIL;
const PASSWORD = process.env.PW_CUSTOMER_PASSWORD;

if (!SLUG) {
  console.error('Set QA_PACK_SLUG to an existing pack slug.');
  process.exit(1);
}

const shots = [];
async function snap(page, name) {
  const path = `${OUT}/vault-room-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  shots.push(path);
  console.log('captured', path);
}

// Logs in via the storefront auth modal (AuthForm.tsx: input[name=email/password],
// submit button reads "Log in"). Waits for the modal to close (customer set) rather
// than a fixed timeout.
async function login(page) {
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.locator('input[name="email"]').waitFor({ state: 'visible' });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.getByRole('button', { name: /^log in$/i }).click();
  await page
    .locator('input[name="email"]')
    .waitFor({ state: 'detached', timeout: 15000 });
}

const browser = await chromium.launch();
for (const [label, viewport, reducedMotion] of [
  ['mobile', { width: 390, height: 844 }, 'no-preference'],
  ['mobile-reduced', { width: 390, height: 844 }, 'reduce'],
  ['desktop', { width: 1440, height: 900 }, 'no-preference'],
]) {
  const ctx = await browser.newContext({ viewport, reducedMotion });
  const page = await ctx.newPage();
  if (EMAIL && PASSWORD) {
    // Login happens from the pack detail page — the spin page itself is a
    // full-screen client component with no header/login button.
    await page.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'domcontentloaded' });
    await login(page);
  }
  await page.goto(`${BASE}/slots/${SLUG}/spin?count=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(300); // mid-entrance
  await snap(page, `${label}-entrance`);
  await page.waitForTimeout(1600); // idle
  await snap(page, `${label}-idle`);
  // add a reel → meter + 2 columns
  const add = page.getByRole('button', { name: 'Add a reel' });
  if (await add.isVisible().catch(() => false)) {
    await add.click();
    await page.waitForTimeout(700);
    await snap(page, `${label}-two-reels`);
    await add.click();
    await page.waitForTimeout(700);
    await snap(page, `${label}-three-reels`);
    await page.getByRole('button', { name: 'Remove a reel' }).click();
    await page.waitForTimeout(600);
    await snap(page, `${label}-removed-reel`);
  }

  // Spin-path (Step 3): only on the first context, and only when logged in
  // with spinnable credit. Reload fresh at count=1 so the spin uses a single
  // reel (skips whatever add/remove state the reel-fit pass above left behind)
  // — keeps spinTotalMs(1) the shortest, most predictable run. Waits on real
  // UI signals (button label / element visibility) rather than guessed
  // timeouts, since exact phase timing depends on reel count (vault-reel.ts).
  if (EMAIL && PASSWORD && label === 'mobile') {
    await page.goto(`${BASE}/slots/${SLUG}/spin?count=1`, {
      waitUntil: 'domcontentloaded',
    });
    const spinBtn = page.getByRole('button', { name: /^spin$/i });
    await spinBtn.waitFor({ timeout: 10000 }).catch(() => {});
    // Balance hydrates client-side (useTopUp fetch) after mount — give it a
    // beat so `canAfford` isn't read while balance is still null (that reads
    // as "disabled" even for a well-funded account).
    await page.waitForTimeout(800);
    if (await spinBtn.isEnabled().catch(() => false)) {
      await spinBtn.click();
      await page.waitForTimeout(200);
      await snap(page, 'spinning');

      // Spoiler check: sample while the button still reads "Spinning…" (i.e.
      // strictly mid-spin, before settle) and confirm no rarity-colored
      // glow/flood is visible yet.
      await page
        .getByRole('button', { name: /spinning/i })
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      await snap(page, 'spin-midpoint-spoiler-check');

      // Flood: the reel settles and the room floods with the rarity wash —
      // the button leaves "Spinning…" once handleSettled fires.
      await page
        .getByRole('button', { name: /spinning/i })
        .waitFor({ state: 'detached', timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(150); // settle into 'flood' before the snap
      await snap(page, 'flood');

      // Transform → review: the card morphs onto the stage; "Flip to reveal
      // your card" mounts once RevealStage reaches 'review'.
      const card = page.getByRole('button', {
        name: /flip to reveal your card/i,
      });
      await card.waitFor({ timeout: 10000 }).catch(() => {});
      // Wait for the button to actually be enabled (phase === 'review') —
      // it mounts disabled during 'transform', then flips enabled.
      await page
        .waitForFunction(
          () => {
            const el = [...document.querySelectorAll('button')].find((b) =>
              /flip to reveal your card/i.test(
                b.getAttribute('aria-label') ?? '',
              ),
            );
            return el && !el.disabled;
          },
          { timeout: 15000 },
        )
        .catch(() => {});
      if (await card.isVisible().catch(() => false)) {
        // scrollIntoViewIfNeeded()/Playwright's own stability check never
        // resolves here — the card has a perpetual idle float (y bob,
        // Infinity repeat), so Playwright treats it as permanently "not
        // stable". Scroll manually via evaluate instead.
        await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(150);
        await snap(page, 'slab-back'); // card on stage, not yet flipped

        // force: true for the same reason as the scroll above.
        await card.click({ force: true });
        await page.waitForTimeout(700); // rotateY flip settle
        await snap(page, 'flipped');

        // The sell button + AuctionClock render below the card — scroll to
        // them so 'clock' actually shows the countdown, not just the card.
        const sellBtn = page.getByRole('button', { name: /^sell for/i });
        if (await sellBtn.isVisible().catch(() => false)) {
          await sellBtn.evaluate((el) =>
            el.scrollIntoView({ block: 'center' }),
          );
          await page.waitForTimeout(150);
        }
        await snap(page, 'clock'); // AuctionClock renders alongside the flipped card

        // Optional: wait out the 30s sell window to see the auto-vault glide-out.
        if (process.env.QA_WAIT_VAULT === '1') {
          await page.waitForTimeout(30000);
          await snap(page, 'vaulted');
        }
      } else {
        console.warn(
          'Reveal never reached the flip step — skipped flipped/clock/vaulted captures.',
        );
      }
    } else {
      console.warn(
        'Spin button disabled (insufficient credit?) — skipped spin-path captures.',
      );
    }
  }
  await ctx.close();
}
await browser.close();
console.log(`\n${shots.length} captures → read them back with the Read tool.`);
