// Guest-only regression check. No signup, payment, or spin is submitted.
// Run against a built storefront: QA_BASE=http://localhost:4180 node scripts/qa-referral-navigation.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.QA_BASE ?? 'http://localhost:4180';
const out = resolve(process.env.QA_OUT ?? 'output/qa-fixes/local');
const referral = process.env.QA_REFERRAL_CODE ?? 'ZFVZ8QLG';
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(45000);
const evidence = {
  base,
  referral,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
};
page.on('pageerror', (error) => evidence.errors.push(error.message));

async function check(name, work) {
  try {
    const detail = await work();
    evidence.checks.push({ name, status: 'PASS', detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    evidence.checks.push({
      name,
      status: 'FAIL',
      error: error.message,
      url: page.url(),
    });
    await page.screenshot({
      path: `${out}/referral-navigation-failure-${evidence.checks.length}.png`,
    });
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRoute(slug, count, heading) {
  await page.waitForURL(
    (url) =>
      url.pathname === `/slots/${slug}` &&
      url.searchParams.get('count') === String(count),
    { waitUntil: 'domcontentloaded', timeout: 15000 },
  );
  await page
    .getByRole('heading', { level: 1, name: heading, exact: true })
    .waitFor();
  const current = page.locator(
    '[data-testid="pack-rail"] a[aria-current="page"]:visible',
  );
  assert(
    (await current.getAttribute('href')) === `/slots/${slug}?count=${count}`,
    'Selected tile disagrees with route or quantity',
  );
  return {
    url: page.url(),
    heading: await page.locator('h1:visible').innerText(),
    selected: await current.innerText(),
  };
}

async function screenshotPack(name) {
  await page.locator('aside:visible').evaluate((element) => {
    window.scrollTo(
      0,
      window.scrollY + element.getBoundingClientRect().top - 84,
    );
  });
  await page.screenshot({ path: `${out}/${name}.png` });
}

try {
  await check('referral landing visibly prefills signup', async () => {
    await page.goto(base, {
      waitUntil: 'domcontentloaded',
    });
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    await reject.click();
    await page.goto(`${base}/r/${encodeURIComponent(referral)}`, {
      waitUntil: 'domcontentloaded',
    });
    const dialog = page.getByRole('dialog', {
      name: 'Create account',
      exact: true,
    });
    await dialog.waitFor();
    await page.waitForFunction(
      (code) =>
        document.querySelector('input[name="referralCode"]')?.value === code,
      referral,
    );
    await page.screenshot({ path: `${out}/referral-landing.png` });
    return {
      url: page.url(),
      code: await dialog.locator('input[name="referralCode"]').inputValue(),
    };
  });

  await check('close, reload, and Join retain stored referral', async () => {
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Create account', exact: true })
      .waitFor();
    await page.waitForFunction(
      (code) =>
        document.querySelector('input[name="referralCode"]')?.value === code,
      referral,
    );
    const cookies = await context.cookies(base);
    const cookie = cookies.find(
      (candidate) => candidate.name === '_polycards_ref',
    );
    assert(cookie?.httpOnly === true, 'Referral cookie must stay httpOnly');
    await page.screenshot({ path: `${out}/referral-after-reload.png` });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    return { code: referral, cookieHttpOnly: cookie.httpOnly };
  });

  await check(
    'Bronze sidebar navigation changes URL and survives reload',
    async () => {
      await page.goto(`${base}/slots/ah?count=1`, {
        waitUntil: 'domcontentloaded',
      });
      await page
        .locator('[data-testid="pack-rail"]')
        .getByRole('link', { name: /^Bronze\s/ })
        .click();
      const beforeReload = await expectRoute('bronze-pack', 1, 'Bronze Pack');
      await page.reload({ waitUntil: 'domcontentloaded' });
      const afterReload = await expectRoute('bronze-pack', 1, 'Bronze Pack');
      await screenshotPack('bronze-sidebar-after-reload');
      return { beforeReload, afterReload };
    },
  );

  await check(
    'Silver sidebar navigation preserves quantity three',
    async () => {
      const increase = page
        .getByTestId('pack-buy-dock')
        .getByRole('button', { name: 'Increase quantity', exact: true });
      await increase.click();
      await increase.click();
      assert(
        await increase.isDisabled(),
        'Quantity did not reach maximum three',
      );
      await page
        .locator('[data-testid="pack-rail"]')
        .getByRole('link', { name: /^Silver\s/ })
        .click();
      const selected = await expectRoute('silver-pack', 3, 'Silver Pack');
      await screenshotPack('silver-quantity-three');
      return selected;
    },
  );

  await check(
    'Back restores Bronze and quantity three consistently',
    async () => {
      await page.goBack({ waitUntil: 'domcontentloaded' });
      const selected = await expectRoute('bronze-pack', 3, 'Bronze Pack');
      assert(
        await page
          .getByTestId('pack-buy-dock')
          .getByRole('button', { name: 'Increase quantity', exact: true })
          .isDisabled(),
        'Back lost quantity three',
      );
      await screenshotPack('bronze-back-quantity-three');
      return selected;
    },
  );

  await check(
    'reload and copied detail URL restore pack and quantity',
    async () => {
      const copiedUrl = page.url();
      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloaded = await expectRoute('bronze-pack', 3, 'Bronze Pack');
      const shared = await context.newPage();
      try {
        await shared.goto(copiedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await shared
          .getByRole('heading', { level: 1, name: 'Bronze Pack', exact: true })
          .waitFor();
        assert(
          await shared
            .getByTestId('pack-buy-dock')
            .getByRole('button', { name: 'Increase quantity', exact: true })
            .isDisabled(),
          'Copied URL lost quantity three',
        );
        await shared.screenshot({
          path: `${out}/bronze-shared-url-quantity-three.png`,
        });
        return { reloaded, sharedUrl: shared.url() };
      } finally {
        await shared.close();
      }
    },
  );
  await check('no browser runtime errors', async () => {
    assert(evidence.errors.length === 0, evidence.errors.join('\n'));
    return { count: evidence.errors.length };
  });
} catch {
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    `${out}/referral-navigation.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await browser.close();
}
