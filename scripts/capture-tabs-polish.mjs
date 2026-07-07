// capture-tabs-polish.mjs — logged-in QA of all five app-shell tabs at phone +
// desktop, full-page + above-the-fold. For the /impeccable polish pass.
// Usage: node scripts/capture-tabs-polish.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'docs/research/polish-tabs';
const EMAIL = process.env.PW_EMAIL ?? 'test@pokenic.app';
const PASSWORD = process.env.PW_PASSWORD ?? 'PokenicTest123!';
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  { name: 'home', path: '/' },
  { name: 'daily', path: '/daily' },
  { name: 'leaderboard', path: '/leaderboard' },
  { name: 'vault', path: '/vault' },
  { name: 'me', path: '/me' },
];
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, dsf: 2 },
  { name: 'desktop', width: 1440, height: 900, dsf: 1 },
];

const browser = await chromium.launch();

async function login(page) {
  await page.goto(BASE + '/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page
    .getByRole('button', { name: 'Accept' })
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.getByRole('button', { name: 'Login' }).first().click();
  await page.getByPlaceholder('Email').last().fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.keyboard.press('Enter');
  await page
    .waitForSelector('text=/RM /', { timeout: 15000 })
    .catch(() => console.log('WARN: no RM balance chip after login'));
  await page.waitForTimeout(1200);
}

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
  });
  const page = await ctx.newPage();
  await login(page);
  for (const route of ROUTES) {
    try {
      await page.goto(BASE + route.path, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(1600);
      await page.screenshot({
        path: path.join(OUT, `${route.name}-${vp.name}.png`),
      });
      await page.screenshot({
        path: path.join(OUT, `${route.name}-${vp.name}-full.png`),
        fullPage: true,
      });
      console.log('ok', route.name, vp.name);
    } catch (err) {
      console.log('FAIL', route.path, vp.name, String(err).slice(0, 160));
    }
  }
  await ctx.close();
}
await browser.close();
console.log('done');
