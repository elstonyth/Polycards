// Read-only browser verification for QA-06/09. No account or money actions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE ?? 'http://localhost:4180';
const OUT = process.env.QA_OUT ?? 'output/qa-fixes/local';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await context.newPage();
const checks = [];
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

function check(ok, label, details = {}) {
  checks.push({ ok, label, ...details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}

async function navigate(path, heading) {
  const response = await page.goto(new URL(path, BASE).href, {
    waitUntil: 'load',
    timeout: 45_000,
  });
  if (!response?.ok()) {
    throw new Error(`${path}: HTTP ${response?.status() ?? 'unavailable'}`);
  }
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Login', exact: true }).waitFor();
  const consent = page.getByRole('dialog', { name: 'Cookie consent' });
  if (await consent.count()) {
    await consent.getByRole('button', { name: 'Reject', exact: true }).click();
  }
}

async function target(locator, label) {
  await locator.waitFor({ state: 'visible' });
  const rect = await locator.boundingBox();
  check(
    Boolean(rect && rect.width >= 43.5 && rect.height >= 43.5),
    `${width}px ${label} target >=44px`,
    { url: page.url(), rect },
  );
}

async function reflow(label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  check(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${width}px ${label} no horizontal overflow`,
    { url: page.url(), ...dimensions },
  );
}

async function screenshot(label, locator) {
  if (width === 320) return;
  if (locator) await locator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/a11y-${width}-${label}.png` });
}

let width;
try {
  for (width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await navigate('/how-it-works', 'Real Cards, Owned Digitally');
    await target(page.getByRole('link', { name: 'Polycards home' }), 'logo');
    const help = page.getByRole('button', {
      name: 'How instant buyback works',
    });
    await target(help, 'buyback help');
    await reflow('How it works');
    await screenshot('buyback-help', help);
    await help.click();
    const dialog = page.getByRole('dialog', { name: 'How buyback works' });
    await dialog.waitFor();
    await target(
      dialog.getByRole('button', { name: 'Close', exact: true }),
      'buyback Close',
    );
    await reflow('buyback modal');
    await screenshot('buyback-dialog');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    check((await dialog.count()) === 0, `${width}px buyback Close dismisses`);

    await navigate('/leaderboard', 'Ranks');
    const stages = page.getByRole('group', { name: 'Challenge stages' });
    const stageButtons = stages.getByRole('button');
    const stageCount = await stageButtons.count();
    check(stageCount > 0, `${width}px challenge stages loaded`);
    for (let index = 0; index < stageCount; index++) {
      const button = stageButtons.nth(index);
      const label = await button.getAttribute('aria-label');
      await target(button, label);
      await button.click();
      check(
        (await button.getAttribute('aria-pressed')) === 'true',
        `${width}px ${label} selects`,
      );
    }
    await reflow('leaderboard');
    await screenshot('leaderboard-stages', stages);
    const standings = page.getByRole('region', { name: 'Standings' });
    const players = standings.locator('a[href^="/profile/"]');
    const playerCount = await players.count();
    check(playerCount > 0, `${width}px public player links loaded`);
    for (let index = 0; index < playerCount; index++) {
      await target(players.nth(index), `player ${index + 1}`);
    }
    await screenshot('leaderboard-players', standings);
    const profilePath = await players.first().getAttribute('href');
    const prize = page.locator('main a[href^="/card/"]').first();
    const cardPath = await prize.getAttribute('href');
    if (!profilePath || !cardPath)
      throw new Error('Public profile/card links unavailable');

    const profileResponse = await page.goto(new URL(profilePath, BASE).href, {
      waitUntil: 'load',
      timeout: 45_000,
    });
    check(profileResponse?.ok(), `${width}px observed public profile loads`, {
      profilePath,
    });
    for (const label of ['Collection', 'Activity']) {
      const tab = page.getByRole('button', { name: label, exact: true });
      await target(tab, `profile ${label}`);
      await tab.click();
      check(
        (await tab.getAttribute('aria-pressed')) === 'true',
        `${width}px profile ${label} selects`,
      );
    }
    await reflow('public profile');
    await screenshot('profile');

    const cardResponse = await page.goto(new URL(cardPath, BASE).href, {
      waitUntil: 'load',
      timeout: 45_000,
    });
    check(cardResponse?.ok(), `${width}px observed public card loads`, {
      cardPath,
    });
    const allPacks = page.getByRole('link', { name: 'All packs', exact: true });
    await target(allPacks, 'card All packs');
    await reflow('public card');
    await screenshot('card', allPacks);
    await allPacks.click();
    await page.waitForURL(new URL('/slots', BASE).href);
    check(
      new URL(page.url()).pathname === '/slots',
      `${width}px All packs navigates`,
    );

    for (const [path, heading, label] of [
      ['/auth/google/failed', 'Sign-in didn’t complete', 'google-failed'],
      ['/reset-password', 'Invalid reset link', 'reset-password'],
    ]) {
      // JSX's apostrophe is straight on the Google failure heading.
      await navigate(path, heading.replace('’', "'"));
      const mainCount = await page.getByRole('main').count();
      check(mainCount === 1, `${width}px ${label} one main landmark`, {
        mainCount,
      });
      await reflow(label);
      await screenshot(label);
    }
  }
  check(pageErrors.length === 0, 'no uncaught browser errors', { pageErrors });
} catch (error) {
  check(false, 'browser verification completed', { error: error.stack });
} finally {
  await browser.close();
  writeFileSync(
    `${OUT}/accessibility-fixes.json`,
    JSON.stringify({ base: BASE, checks, pageErrors }, null, 2),
  );
}
process.exitCode = checks.every((result) => result.ok) ? 0 : 1;
