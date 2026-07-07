// One-off capture: where the admin configures the market-price margin.
// Logs into the admin, opens the first card's edit panel on /dashboard/cards,
// highlights the "Markup %" field (Card.market_multiplier), screenshots it.
// Usage: node scripts/capture-margin-field.mjs   (backend :9000 + admin :7000 up)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const BASE = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
const OUT = 'docs/research/admin-margin-field.png';
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
if (!PW) {
  console.error('No ADMIN_PW found (env or scripts/.dev-logins)');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const go = (url) =>
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  await go(`${BASE}/login`);
  await page.waitForSelector('input[name=email], input[type=email]', {
    timeout: 15000,
  });
  await page.fill('input[name=email], input[type=email]', EMAIL);
  await page.fill('input[name=password], input[type=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.includes('login'), {
    timeout: 20000,
  });
  console.log('logged in');

  await go(`${BASE}/cards`);
  await page.waitForSelector('table tbody tr', { timeout: 20000 });

  // Only PriceCharting-LINKED cards render the markup field — search for the
  // known linked card instead of scanning rows (pass CARD_QUERY to override).
  const query = process.env.CARD_QUERY || 'Pikachu';
  await page.fill('input[aria-label="Search cards by name or handle"]', query);
  await page.waitForTimeout(1200); // debounced search
  await page
    .locator('table tbody tr')
    .first()
    .getByRole('button', { name: /edit/i })
    .click();
  const found = await page
    .waitForSelector('#card-markup', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!found) throw new Error(`'${query}' edit panel exposed no #card-markup`);

  // Ring the field + its label so the screenshot points at it.
  await page.evaluate(() => {
    const input = document.querySelector('#card-markup');
    const label = document.querySelector('label[for=card-markup]');
    for (const el of [input, label])
      if (el)
        el.style.cssText +=
          ';outline:3px solid #f43f5e;outline-offset:3px;border-radius:6px';
    input?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT });
  console.log(`shot -> ${OUT}`);
} finally {
  await browser.close();
}
