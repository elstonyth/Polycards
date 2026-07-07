// One-off verify: card thumbnails render again after repull-pc-images.
// Shoots the admin /cards list + a storefront pack page's Top Hits.
// Usage: node scripts/capture-images-verify.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

mkdirSync('docs/research', { recursive: true });

function devLogin(key, fallback) {
  if (process.env[key]) return process.env[key];
  const f = 'scripts/.dev-logins';
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return fallback;
}
const EMAIL = devLogin('ADMIN_EMAIL', 'admin@pokenic.app');
const PW = devLogin('ADMIN_PW', '');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const go = (url) =>
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // storefront pack page (public) — Top Hits grid
  await go('http://127.0.0.1:4000/slots/pokemon-trainer');
  await page.waitForTimeout(3500); // images + reveal animations settle
  await page.screenshot({
    path: 'docs/research/verify-storefront-tophits.png',
    fullPage: true,
  });
  console.log('shot storefront');

  // admin cards list
  if (PW) {
    await go('http://localhost:7000/dashboard/login');
    await page.waitForSelector('input[name=email], input[type=email]', {
      timeout: 15000,
    });
    await page.fill('input[name=email], input[type=email]', EMAIL);
    await page.fill('input[name=password], input[type=password]', PW);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.includes('login'), {
      timeout: 20000,
    });
    await go('http://localhost:7000/dashboard/cards');
    await page.waitForSelector('table tbody tr', { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.screenshot({
      path: 'docs/research/verify-admin-cards.png',
      fullPage: false,
    });
    console.log('shot admin');
  }
} finally {
  await browser.close();
}
