// qa-app-ux-pass.mjs — logged-in sweep of every app (product-register) surface
// at phone + desktop widths, for the UI/UX + motion pass.
// Usage: node scripts/qa-app-ux-pass.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'docs/research/app-ux-pass';

// Creds come from the gitignored scripts/.dev-logins (never printed), or from
// the environment where that file doesn't exist (fresh clone, CI).
const CREDS_FILE = path.join(process.cwd(), 'scripts/.dev-logins');
const creds = existsSync(CREDS_FILE)
  ? Object.fromEntries(
      readFileSync(CREDS_FILE, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          // A missing "=" makes indexOf return -1, and slice(0, -1) would hand
          // back a plausible-looking key with a silently wrong value — the
          // login would then fail 20s later with no clue why.
          if (i <= 0)
            throw new Error(`Malformed line in scripts/.dev-logins: ${l}`);
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};
const EMAIL = creds.CUST_EMAIL ?? process.env.PW_EMAIL;
const PASSWORD = creds.CUST_PW ?? process.env.PW_PASSWORD;
// Preflight: an empty password silently produces a sweep of logged-out pages.
if (!EMAIL || !PASSWORD) {
  throw new Error(
    'No customer credentials. Set CUST_EMAIL/CUST_PW in scripts/.dev-logins, ' +
      'or PW_EMAIL/PW_PASSWORD in the environment.',
  );
}

const ROUTES = [
  ['slots', '/slots'],
  ['pack-detail', '/slots/bronze-pack'],
  ['vault', '/vault'],
  ['me', '/me'],
  ['wallet', '/wallet'],
  ['transactions', '/transactions'],
  ['vip', '/vip'],
  ['orders', '/orders'],
  ['notifications', '/notifications'],
  ['leaderboard', '/leaderboard'],
  ['task', '/task'],
  ['settings', '/settings'],
];

const VIEWPORTS = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

for (const [vpName, viewport] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
  });

  await page.goto(BASE + '/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page
    .getByRole('button', { name: 'Accept' })
    .click({ timeout: 5000 })
    .catch(() => {});
  const loginBtn = page
    .locator('header')
    .getByRole('button', { name: /^login$/i })
    .first();
  await loginBtn.waitFor({ state: 'visible', timeout: 45000 });
  await loginBtn.click();
  const email = page.locator('input[name="email"]');
  await email.waitFor({ state: 'visible', timeout: 20000 });
  await email.fill(EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  // Modal detaching = the login round-trip actually succeeded. Throw rather
  // than warn: a swallowed failure sweeps every route logged OUT and still
  // exits 0, which is exactly how the first run of this script produced a
  // directory of identical redirect screenshots.
  await email.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {
    throw new Error(
      `[${vpName}] login did not complete — the auth modal never closed`,
    );
  });

  for (const [name, route] of ROUTES) {
    await page.goto(BASE + route, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Reveal/IntersectionObserver + image decode settle.
    await page.waitForTimeout(1800);
    await page.screenshot({
      path: path.join(OUT, `${name}-${vpName}.png`),
      fullPage: true,
    });
  }

  if (errors.length) {
    console.log(`ERRORS[${vpName}]:\n` + [...new Set(errors)].join('\n'));
  }
  await ctx.close();
}

await browser.close();
console.log('wrote ' + OUT);
