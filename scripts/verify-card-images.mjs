// Post-repull verification: screenshot the admin cards list + a storefront
// pack page's Top Hits to confirm card thumbnails render again.
// Usage: node scripts/verify-card-images.mjs
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

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const go = (url) =>
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // --- admin cards list ---
  await go('http://localhost:7000/dashboard/login');
  await page.waitForSelector('input[name=email], input[type=email]', {
    timeout: 15000,
  });
  await page.fill(
    'input[name=email], input[type=email]',
    devLogin('ADMIN_EMAIL', 'admin@pokenic.app'),
  );
  await page.fill(
    'input[name=password], input[type=password]',
    devLogin('ADMIN_PW', ''),
  );
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.includes('login'), {
    timeout: 20000,
  });
  await go('http://localhost:7000/dashboard/cards');
  await page.waitForSelector('table tbody tr', { timeout: 20000 });
  await page.waitForTimeout(2500); // let thumbs load
  await page.screenshot({ path: 'docs/research/verify-admin-cards.png' });
  console.log('shot admin cards list');

  // --- PR #81's new admin Storefront settings page ---
  await go('http://localhost:7000/dashboard/storefront');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'docs/research/verify-admin-storefront.png' });
  console.log('shot admin storefront settings');

  // --- storefront pack Top Hits (pokemon-black has curated top hits) ---
  await go('http://127.0.0.1:4000/slots/pokemon-black');
  await page.waitForTimeout(3000); // reveal animations + images
  await page.screenshot({
    path: 'docs/research/verify-top-hits.png',
    fullPage: true,
  });
  console.log('shot storefront pack page');
} finally {
  await browser.close();
}
