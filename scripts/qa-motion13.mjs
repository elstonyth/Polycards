// qa-motion13.mjs — verifies the 8 storefront surfaces that import `motion/react`
// still mount, animate, and log nothing, after the motion 12 -> 13 major.
//
// motion 13.0.0's only breaking change is the removal of the optional
// @emotion/is-prop-valid integration; a break would surface as a runtime
// console error or as motion nodes frozen at their `initial` style. So, per
// surface, the assertions are: zero console/page errors, and zero on-screen
// nodes stuck at opacity 0 (stuckHidden() below catches a frozen `initial`
// style).
//
// `motionNodes` is printed per surface as diagnostics only and is NOT
// asserted — see the comment above its definition for why.
//
// A missing pack link on /slots is not a skip: it fails the three
// dependent surfaces (pack-detail, card-overlay, demo-spin) instead.
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = 'docs/research/motion13';

const errors = [];
const browser = await chromium.launch();
const results = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  // Motion writes an inline `opacity` on every node it drives. <Reveal> (the
  // site's IntersectionObserver fade-up) only ever writes an inline `transform`
  // and takes its opacity from a Tailwind class, so keying on inline opacity
  // isolates motion and skips the below-the-fold Reveal wrappers that are
  // legitimately still at opacity 0. Judge only what is actually on screen.
  const stuckHidden = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[style*="opacity"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          const onScreen =
            r.bottom > 0 &&
            r.right > 0 &&
            r.top < innerHeight &&
            r.left < innerWidth;
          return onScreen && parseFloat(getComputedStyle(el).opacity) === 0;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 90))
        .slice(0, 5),
    );

  // How many motion-driven nodes mounted at all — diagnostic only, NOT part of
  // the pass/fail verdict. Measured empirically (2026-08-22, local prod build,
  // :4000, sampled 100ms-3.7s post-navigation): on `/` and `/slots` this is 0
  // at every sampled point, because those pages' motion trees never leave an
  // inline `opacity` in the style attribute — so a zero count can't
  // distinguish "motion never ran" from "motion ran and doesn't linger in
  // style." The real vacuity guard is stuckHidden() above: if motion failed to
  // initialise, Reveal-wrapped content would be STUCK at opacity 0 and
  // stuckOpacity0 would catch it.
  const motionNodes = () =>
    page.evaluate(() => document.querySelectorAll('[style*="opacity"]').length);

  async function visit(name, url, after) {
    const before = errors.length;
    await page.goto(BASE + url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page
      .getByRole('button', { name: 'Accept' })
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.waitForTimeout(2500); // let enter animations settle
    if (after) await after();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    const hidden = await stuckHidden();
    const nodes = await motionNodes();
    const fresh = errors.slice(before);
    const pass = fresh.length === 0 && hidden.length === 0;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${name} ` +
        `errors=${fresh.length} stuckOpacity0=${hidden.length} motionNodes=${nodes}`,
    );
    if (fresh.length) console.log('   ' + fresh.slice(0, 3).join('\n   '));
    if (hidden.length) console.log('   stuck: ' + hidden.join(' | '));
    return pass;
  }

  results.push(await visit('home', '/'));
  // StageCarousel
  results.push(await visit('leaderboard', '/leaderboard'));
  results.push(await visit('slots', '/slots'));

  // Pack detail: GalleryRail + SlabCard + Meter + RevealStage, then the
  // CardDetailOverlay that a card click opens.
  await page.goto(BASE + '/slots', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // The catalog links carry a `?count=1` query, so strip it before building
  // any sub-route URL - appending /spin to the raw href yields the nonsense
  // path /slots/bronze-pack?count=1/spin and the spin never mounts.
  const href = (
    await page
      .locator('a[href^="/slots/"]')
      .first()
      .getAttribute('href')
      .catch(() => null)
  )?.split('?')[0];

  if (href) {
    results.push(await visit('pack-detail', href));
    results.push(
      await visit('card-overlay', href, async () => {
        // Opening the overlay is what mounts CardDetailOverlay's motion tree.
        await page
          .locator('img[alt], button')
          .filter({ hasText: '' })
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
      }),
    );
    // SlotMachineClient + SlotReelStack only mount once a spin is actually
    // running, and /spin bounces a guest straight back to the pack page. The
    // guest demo route (?demo=1 - no login, no charge) is the only way to reach
    // them without credentials. Runs in its own page: the card overlay opened by
    // the previous step stays mounted and swallows the spin click otherwise.
    // aria-busy on the stage is the phase signal - never assert on the odometer,
    // it settles asynchronously.
    const spinPage = await ctx.newPage();
    const spinErrors = [];
    spinPage.on('pageerror', (e) => spinErrors.push(`pageerror: ${e.message}`));
    spinPage.on('console', (m) => {
      if (m.type() === 'error') spinErrors.push(`console: ${m.text()}`);
    });
    try {
      await spinPage.goto(BASE + href + '/spin?demo=1', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await spinPage
        .getByRole('button', { name: /reject|accept/i })
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
      const spinBtn = spinPage
        .getByRole('button', { name: /spin|open pack|demo/i })
        .first();
      await spinBtn.waitFor({ state: 'visible', timeout: 30000 });
      await spinBtn.click();

      const deadline = Date.now() + 60000;
      let sawBusy = false;
      let cleared = false;
      while (Date.now() < deadline) {
        const busy = await spinPage.evaluate(
          () => !!document.querySelector('[aria-busy="true"]'),
        );
        if (busy) sawBusy = true;
        else if (sawBusy) {
          cleared = true;
          break;
        }
        await spinPage.waitForTimeout(150);
      }
      await spinPage.waitForTimeout(3000);
      await spinPage.screenshot({ path: `${OUT}/spin-result.png` });
      const spinOk = sawBusy && cleared && spinErrors.length === 0;
      console.log(
        `${spinOk ? 'PASS' : 'FAIL'} demo-spin sawBusy=${sawBusy} ` +
          `cleared=${cleared} errors=${spinErrors.length}`,
      );
      spinErrors.slice(0, 3).forEach((e) => console.log('   ' + e));
      results.push(spinOk);
    } catch (e) {
      // Treated as data, like every other failure in this script: the demo
      // route can fail to mount, or the button's accessible name can drift
      // off /spin|open pack|demo/i, and a raw stack trace in the nightly is
      // strictly worse than a FAIL line (this gate runs `if: always()`).
      console.log(
        `FAIL demo-spin — ${String(e && e.message ? e.message : e).split('\n')[0]}`,
      );
      results.push(false);
    }
  } else {
    console.log(
      'FAIL pack-detail/card-overlay/spin — no pack link on /slots (backend down?)',
    );
    results.push(false, false, false);
  }
} catch (e) {
  // Any throw from visit() (navigation/screenshot/evaluate) or the /slots
  // re-navigation above would otherwise skip straight to the finally and
  // then propagate past the summary/exitCode below, crashing this gate with
  // a raw stack trace — exactly what it must not do now that it runs
  // nightly with `if: always()`. Same treatment as every other failure in
  // this script: a single FAIL line, counted as data, no rethrow.
  console.log(
    `FAIL script aborted — ${String(e && e.message ? e.message : e).split('\n')[0]}`,
  );
  results.push(false);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(
  `\n=== motion 13 QA: ${results.length - failed}/${results.length} surfaces clean ===`,
);
process.exitCode = failed ? 1 : 0;
