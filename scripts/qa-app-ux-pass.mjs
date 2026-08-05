// qa-app-ux-pass.mjs — logged-in sweep of every app (product-register) surface
// at phone + desktop widths, for the UI/UX + motion pass.
// Usage: node scripts/qa-app-ux-pass.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'docs/research/app-ux-pass';
// Creds come from the gitignored scripts/.dev-logins (never printed).
const creds = Object.fromEntries(
  readFileSync(path.join(process.cwd(), 'scripts/.dev-logins'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const EMAIL = creds.CUST_EMAIL ?? 'test@polycards.app';
const PASSWORD = creds.CUST_PW ?? '';

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
  // Modal detaching = the login round-trip actually succeeded.
  await email
    .waitFor({ state: 'detached', timeout: 20000 })
    .catch(() => console.log(`WARN[${vpName}]: login modal never closed`));

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
