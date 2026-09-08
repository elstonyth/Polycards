// Guest-only regression checks for production QA findings QA-01/04/05.
// Demo spins do not create purchases or use an account balance.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.argv[2] ?? 'http://localhost:4180';
const out = process.argv[3] ?? 'output/qa-fixes/local';
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const requests = [];
const errors = [];
const checks = [];
page.on('request', (request) => requests.push(request.url()));
page.on('pageerror', (error) => errors.push(error.message));

async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const reject = page.getByRole('button', { name: 'Reject', exact: true });
  await reject.click({ timeout: 15000 });
  await check('favicon is a served icon', async () => {
    const response = await context.request.get(`${base}/favicon.ico`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/image\//);
    expect((await response.body()).length).toBeGreaterThan(100);
  });

  await page.goto(`${base}/fairness`, { waitUntil: 'domcontentloaded' });
  await check('fairness states current proof availability', async () => {
    await expect(page.locator('main')).toContainText(
      'Independent per-pull verification is not available yet',
    );
    await expect(page.locator('main')).toContainText(
      'Signing in does not unlock proofs',
    );
    await expect(
      page.getByRole('link', { name: /Browse packs/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Browse packs/ }).locator('..'),
    ).toHaveCSS('opacity', '1');
  });
  await page.screenshot({
    path: path.join(out, 'fairness.png'),
    fullPage: true,
  });

  for (const slug of [
    'bronze-pack',
    'silver-pack',
    'gold-pack',
    'platinum-pack',
    'diamond-pack',
    'ah',
  ]) {
    await page.goto(`${base}/slots/${slug}`, { waitUntil: 'domcontentloaded' });
    await check(`${slug} distinguishes instant and vault buyback`, async () => {
      await expect(page.locator('main')).toContainText('instant buyback');
      await expect(page.locator('main')).toContainText(
        '90% of card value in your vault',
      );
    });
    if (slug === 'bronze-pack')
      await page.screenshot({
        path: path.join(out, 'bronze-copy.png'),
        fullPage: true,
      });
    await page.goto(`${base}/slots/${slug}/spin?demo=1`, {
      waitUntil: 'domcontentloaded',
    });
    await check(`${slug} demo reveal and return`, async () => {
      const spin = page.getByRole('button', { name: 'Demo spin', exact: true });
      await expect(spin).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: 'Odds', exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: 'Pull odds by rarity' }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Close odds', exact: true })
        .click();
      await spin.click();
      const flip = page.getByRole('button', {
        name: 'Flip to reveal your card',
        exact: true,
      });
      await expect(flip).toBeVisible({ timeout: 45000 });
      await expect(flip).toBeEnabled({ timeout: 15000 });
      // The card floats continuously; a pointer click matches a real user's
      // action without waiting for its animated transform to become stable.
      const cardBox = await flip.boundingBox();
      expect(cardBox).not.toBeNull();
      await page.mouse.click(
        cardBox.x + cardBox.width / 2,
        cardBox.y + cardBox.height / 2,
      );
      const back = page.getByRole('button', {
        name: 'Back to the reel',
        exact: true,
      });
      await expect(back).toBeVisible();
      await page.screenshot({ path: path.join(out, `demo-${slug}.png`) });
      await back.click();
      await expect(
        page.getByRole('button', { name: 'Spin again', exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Exit', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/slots/${slug}(?:\\?|$)`));
    });
  }
  await check('no missing 994/995 animated sprites requested', async () => {
    expect(
      requests.filter((url) => /\/showdown\/(994|995)\.gif/.test(url)),
    ).toEqual([]);
  });
  await check('no uncaught browser errors', async () =>
    expect(errors).toEqual([]),
  );
} finally {
  await writeFile(
    path.join(out, 'copy-sprites-results.json'),
    JSON.stringify(
      { base, checks, errors, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  await browser.close();
}
