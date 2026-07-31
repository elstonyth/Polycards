// QA: "Cards in this pack" rail + expand modal (feat/pack-pool-modal).
// Usage: node scripts/qa-pool-modal.mjs [baseUrl]
// Screenshots to docs/research/qa-pool-modal-*.png, JSON to stdout.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
mkdirSync('docs/research', { recursive: true });

const browser = await chromium.launch();
try {
  // Find pack slugs that actually render the section (needs a Rare+ pool).
  const scout = await browser.newPage();
  await scout.goto(`${BASE}/slots`, { waitUntil: 'domcontentloaded' });
  await scout.waitForTimeout(2000);
  const slugs = await scout.evaluate(() =>
    [...document.querySelectorAll('a[href^="/slots/"]')]
      .map((a) => a.getAttribute('href').replace('/slots/', ''))
      .filter((s) => s && !s.includes('/')),
  );
  await scout.close();
  console.log(JSON.stringify({ slugs }));

  for (const [label, viewport] of [
    ['mobile', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
  ]) {
    let done = false;
    for (const slug of [...new Set(slugs)]) {
      if (done) break;
      const page = await browser.newPage({ viewport });
      await page.goto(`${BASE}/slots/${slug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const h2 = page.locator('h2', { hasText: 'Cards in this pack' }).first();
      try {
        await h2.waitFor({ timeout: 8000 });
      } catch {
        await page.close();
        continue;
      }
      await h2.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200); // Reveal animation + images
      await page.screenshot({
        path: `docs/research/qa-pool-modal-${label}-1-rail.png`,
      });

      // Expand via the header icon button.
      const expand = page.locator('button[aria-label^="Show all"]').first();
      await expand.click();
      const dialog = page.locator(
        '[role="dialog"][aria-label="Cards in this pack"]',
      );
      await dialog.waitFor({ timeout: 5000 });
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => {
        const d = document.querySelector(
          '[role="dialog"][aria-label="Cards in this pack"]',
        );
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
      });
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
      const afterEsc1 = await page.evaluate(() => ({
        overlays: document.querySelectorAll('.glass-scrim').length,
        dialogs: document.querySelectorAll(
          '[role="dialog"][aria-label="Cards in this pack"]',
        ).length,
      }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterEsc2 = await page.evaluate(() => ({
        dialogs: document.querySelectorAll(
          '[role="dialog"][aria-label="Cards in this pack"]',
        ).length,
        bodyOverflow: document.body.style.overflow,
      }));
      const escStack =
        afterEsc1.overlays === 0 &&
        afterEsc1.dialogs === 1 &&
        afterEsc2.dialogs === 0 &&
        afterEsc2.bodyOverflow !== 'hidden';
      console.log(
        JSON.stringify({ slug, label, afterEsc1, afterEsc2, escStack }),
      );

      // Mouse drag-to-scroll on the rail: drag moves scrollLeft and opens
      // nothing; a plain click still opens the card overlay. Only meaningful
      // where the rail overflows (narrow viewports).
      const rail = page.locator('div.cursor-grab').first();
      const dims = await rail.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }));
      if (dims.sw > dims.cw) {
        const box = await rail.boundingBox();
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
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
        console.log(
          JSON.stringify({
            slug,
            label,
            drag: {
              scrolled,
              dragScrolls: scrolled > 0,
              overlayAfterDrag,
              overlayAfterClick,
              clickStillWorks:
                overlayAfterDrag === 0 && overlayAfterClick === 1,
            },
          }),
        );
      } else {
        console.log(
          JSON.stringify({ slug, label, drag: 'rail does not overflow here' }),
        );
      }
      done = true;
      await page.close();
    }
    if (!done)
      console.log(
        JSON.stringify({ label, error: 'no pack with pool section' }),
      );
  }
} finally {
  await browser.close();
}
