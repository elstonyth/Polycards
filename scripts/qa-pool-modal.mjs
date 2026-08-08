// QA: pool rail ("Top Hits" / "All cards") + expand modal on /slots/[slug].
// Usage: node scripts/qa-pool-modal.mjs [baseUrl]
// Screenshots to docs/research/qa-pool-modal-*.png, JSON to stdout.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
mkdirSync('docs/research', { recursive: true });

// The dialog's aria-label mirrors its heading — "Top Hits" normally,
// "All cards" for a pack with no top-tier cards. One selector for both, and
// specific enough to never match the cookie-consent dialog.
const DIALOG_SEL =
  '[role="dialog"][aria-label="Top Hits"], [role="dialog"][aria-label="All cards"]';

// Every probe boolean below (scrollable, dragScrolls, clickStillWorks,
// escStack, the heading/rail consistency check) feeds this -- a failed
// probe must fail the process, not just print a log line nobody reads.
let anyFailure = false;

const browser = await chromium.launch();
try {
  // Find pack slugs that actually render the section (any non-empty pool —
  // "Top Hits" normally, the "All cards" fallback for zero-top-hit packs).
  const scout = await browser.newPage();
  await scout.goto(`${BASE}/slots`, { waitUntil: 'domcontentloaded' });
  await scout.waitForTimeout(2000);
  // Hrefs may carry a query (?count=1 since the qty presets) — strip it, or
  // every derived slug 404s the later checks. Dedupe at the source.
  const slugs = await scout.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('a[href^="/slots/"]')]
        .map((a) => a.getAttribute('href').replace('/slots/', '').split('?')[0])
        .filter((s) => s && !s.includes('/')),
    ),
  ]);
  await scout.close();
  console.log(JSON.stringify({ slugs }));

  for (const [label, viewport] of [
    ['mobile', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
  ]) {
    let done = false;
    for (const slug of slugs) {
      if (done) break;
      const page = await browser.newPage({ viewport });
      await page.goto(`${BASE}/slots/${slug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const h2 = page
        .locator('h2', { hasText: /^(Top Hits|All cards)$/ })
        .first();
      try {
        await h2.waitFor({ timeout: 8000 });
      } catch {
        await page.close();
        continue;
      }
      const headingText = (await h2.textContent())?.trim();
      await h2.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200); // Reveal animation + images
      await page.screenshot({
        path: `docs/research/qa-pool-modal-${label}-1-rail.png`,
      });

      // Expand via the header icon button (aria: "Show the N top-tier
      // cards grouped by rarity" / "Show all N cards grouped by rarity").
      const expand = page
        .locator('button[aria-label*="grouped by rarity"]')
        .first();
      await expand.click();
      const dialog = page.locator(DIALOG_SEL);
      await dialog.waitFor({ timeout: 5000 });
      await page.waitForTimeout(1200);
      const m = await page.evaluate((sel) => {
        const d = document.querySelector(sel);
        const headers = [...d.querySelectorAll('h3')].map((h) => {
          const row = h.closest('div');
          return row ? row.textContent.trim() : h.textContent;
        });
        return {
          tierHeaders: headers,
          cardCount: d.querySelectorAll('button[aria-label^="View details"]')
            .length,
          scrollable: d.scrollHeight > d.clientHeight,
        };
      }, DIALOG_SEL);
      // Only demand a scrollable dialog when it holds more than two grid
      // rows' worth of cards — the top-tier subset can be small enough to
      // fit inside the 85vh panel, and that's healthy, not a regression.
      if (!m.scrollable && m.cardCount > 6) anyFailure = true;
      console.log(JSON.stringify({ slug, label, ...m }));
      await page.screenshot({
        path: `docs/research/qa-pool-modal-${label}-2-modal.png`,
      });

      // Card tap inside the modal -> CardDetailOverlay above it.
      await dialog
        .locator('button[aria-label^="View details"]')
        .first()
        .click();
      await page.waitForTimeout(1200);
      await page.screenshot({
        path: `docs/research/qa-pool-modal-${label}-3-card-overlay.png`,
      });

      // Escape must close ONE layer at a time (topmost first) — asserting the
      // intermediate state catches the both-close-at-once + stranded
      // body{overflow:hidden} bug the shared modalStack in use-modal-a11y
      // guards against.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterEsc1 = await page.evaluate(
        (sel) => ({
          overlays: document.querySelectorAll('.glass-scrim').length,
          dialogs: document.querySelectorAll(sel).length,
        }),
        DIALOG_SEL,
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterEsc2 = await page.evaluate(
        (sel) => ({
          dialogs: document.querySelectorAll(sel).length,
          bodyOverflow: document.body.style.overflow,
        }),
        DIALOG_SEL,
      );
      const escStack =
        afterEsc1.overlays === 0 &&
        afterEsc1.dialogs === 1 &&
        afterEsc2.dialogs === 0 &&
        afterEsc2.bodyOverflow !== 'hidden';
      if (!escStack) anyFailure = true;
      console.log(
        JSON.stringify({ slug, label, afterEsc1, afterEsc2, escStack }),
      );

      // Mouse drag-to-scroll on the rail: drag moves scrollLeft and opens
      // nothing; a plain click still opens the card overlay. Only meaningful
      // where the rail overflows (narrow viewports). A zero-top-hit pack (the
      // "All cards" fallback) renders NO rail at all — count() first, or
      // rail.evaluate() would wait 30s and throw, aborting the whole run.
      const rail = page.locator('div.cursor-grab').first();
      if ((await page.locator('div.cursor-grab').count()) === 0) {
        if (headingText === 'All cards') {
          // Genuine zero-top-hit fallback -- no rail is correct here. Don't
          // mark done: keep looking for a pack with top-tier cards so the
          // drag probe actually runs at least once per viewport.
          console.log(
            JSON.stringify({
              slug,
              label,
              drag: 'skipped: no rail (zero-top-hit "All cards" fallback)',
            }),
          );
        } else {
          // The heading says "Top Hits" (or is unrecognized) but no
          // rail rendered -- that's a real regression, not the documented
          // zero-top-hit edge case.
          anyFailure = true;
          console.log(
            JSON.stringify({
              slug,
              label,
              drag: `FAIL: no rail but heading is "${headingText}", not "All cards"`,
            }),
          );
        }
        await page.close();
        continue;
      }
      const dims = await rail.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }));
      // boundingBox() is null when the rail isn't visible — bail with a
      // report line instead of throwing and aborting the whole run. Require
      // MEANINGFUL overflow (> 40px, roughly a quarter card): the Top Hits
      // subset is small, and on wide viewports the negative-margin/padding
      // hack leaves a few sub-card pixels of scrollWidth that a drag can't
      // register against — that's not a drag regression.
      if (dims.sw - dims.cw > 40) await rail.scrollIntoViewIfNeeded();
      const box = dims.sw - dims.cw > 40 ? await rail.boundingBox() : null;
      if (box) {
        const cx = box.x + box.width / 2;
        // Clamp INSIDE the viewport: the rail is tall (slab halo padding) and
        // its box center can land below the fold — mouse events at off-screen
        // coordinates silently no-op and read as a fake drag regression.
        const vh = page.viewportSize().height;
        const cy = Math.min(Math.max(box.y + box.height / 2, 10), vh - 10);
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(cx - i * 25, cy);
        await page.mouse.up();
        await page.waitForTimeout(300);
        const scrolled = await rail.evaluate((el) => el.scrollLeft);
        const overlayAfterDrag = await page.locator('.glass-scrim').count();
        await rail
          .locator('button[aria-label^="View details"]')
          .first()
          .click();
        await page.waitForTimeout(600);
        const overlayAfterClick = await page.locator('.glass-scrim').count();
        await page.keyboard.press('Escape');
        const dragScrolls = scrolled > 0;
        const clickStillWorks =
          overlayAfterDrag === 0 && overlayAfterClick === 1;
        if (!dragScrolls || !clickStillWorks) anyFailure = true;
        console.log(
          JSON.stringify({
            slug,
            label,
            drag: {
              scrolled,
              dragScrolls,
              overlayAfterDrag,
              overlayAfterClick,
              clickStillWorks,
            },
          }),
        );
      } else {
        // Not marking done — mirror the no-rail branch: the Top Hits rail
        // is small and often fits wide viewports, so keep scanning packs
        // until one overflows and the drag probe actually runs.
        console.log(
          JSON.stringify({
            slug,
            label,
            drag: 'skipped: rail not overflowing or not visible',
          }),
        );
        await page.close();
        continue;
      }
      done = true;
      await page.close();
    }
    if (!done)
      console.log(
        JSON.stringify({
          label,
          warning:
            'drag probe never ran: no pack with a pool section and an overflowing rail',
        }),
      );
  }
  if (anyFailure) process.exitCode = 1;
} finally {
  await browser.close();
}
