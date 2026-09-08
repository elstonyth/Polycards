import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4010';
const out = 'output/qa-telegram-banner';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [768, 1024],
    [844, 390],
    [1440, 900],
    [2560, 1440],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.route('**/api/me', (route) =>
      route.fulfill({
        json: {
          customer: {
            id: 'telegram-qa',
            email: 'telegram-qa@example.com',
            first_name: 'QA',
            last_name: null,
            handle: null,
            avatar_url: null,
          },
        },
      }),
    );
    await page.route('**/api/free-pack', (route) =>
      route.fulfill({ json: { mode: 'signup' } }),
    );
    await page.goto(`${base}/about`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('[data-telegram-banner]').count(), 0);
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    const ticket = page.locator('[data-telegram-banner]');
    await ticket.waitFor({ state: 'visible' });
    await page.getByTestId('free-pack-badge').waitFor({ state: 'visible' });
    const bounds = await ticket.boundingBox();
    assert(bounds && bounds.width >= 160 && bounds.width <= 241);
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert(bounds.y >= 0 && bounds.y + bounds.height <= height);
    assert.equal(
      await ticket.locator('a').getAttribute('href'),
      'https://t.me/polycardsgg',
    );
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-telegram-banner] img');
      return (
        img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
      );
    });
    const pack = await page.getByTestId('free-pack-badge').boundingBox();
    assert(pack.y + pack.height <= bounds.y - 8, 'Badges overlap');
    if (width < 1024) {
      const nav = await page
        .getByRole('navigation', { name: 'Primary' })
        .boundingBox();
      assert(bounds.y + bounds.height <= nav.y - 6, 'Ticket overlaps tabs');
    }
    await ticket.locator('a').focus();
    assert(
      await ticket.locator('a').evaluate((el) => el === document.activeElement),
    );
    await page.screenshot({ path: `${out}/${width}x${height}.png` });
    const close = page.getByRole('button', { name: 'Dismiss Telegram banner' });
    const closeBounds = await close.boundingBox();
    assert(closeBounds.width >= 44 && closeBounds.height >= 44);
    assert(pack.y + pack.height <= closeBounds.y, 'Close overlaps free pack');
    await close.click();
    assert.equal(await ticket.count(), 0);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await ticket.count(), 0, 'Dismissal must survive reload');
    await page.evaluate(() =>
      sessionStorage.removeItem('polycards.telegram-banner-session-dismissed'),
    );
    await page.reload({ waitUntil: 'networkidle' });
    await ticket.waitFor({ state: 'visible' });
    let tapped = false;
    await page.route('https://t.me/polycardsgg', async (route) => {
      tapped = true;
      await route.fulfill({
        contentType: 'text/plain',
        body: 'Telegram destination',
      });
    });
    await ticket.locator('a').click();
    await page.waitForURL('https://t.me/polycardsgg');
    assert(tapped, 'Ticket did not navigate directly to Telegram');
    await page.goto(`${base}/about`, { waitUntil: 'networkidle' });
    await ticket.waitFor({ state: 'visible' });
    assert.equal(
      await ticket.count(),
      1,
      'Telegram link does not dismiss banner',
    );
    console.log(
      `${width}x${height}: sizing, navigation clearance, stacking, focus, link passed`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
