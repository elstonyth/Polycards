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

      // Escape closes overlay, second Escape closes modal.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const modalGone = (await dialog.count()) === 0;
      console.log(JSON.stringify({ slug, label, modalGone }));
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
