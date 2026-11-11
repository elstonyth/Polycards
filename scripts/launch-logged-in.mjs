// Opens a headed browser, logs in as ADMIN (:7000) and CUSTOMER (:4000),
// screenshots proof, and stays open for manual use. Ctrl-C to quit.
// Run: node scripts/launch-logged-in.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright'); // ponytail: global playwright via NODE_PATH
import { adminUiLogin, requireAdminTotp } from './lib/admin-sign-in.mjs';

// Credentials come from the environment — never hardcode secrets in source.
// ADMIN_PASSWORD + CUSTOMER_PASSWORD are required; emails default to the standing
// dev ids. Run: ADMIN_PASSWORD=… CUSTOMER_PASSWORD=… node scripts/launch-logged-in.mjs
const ADMIN = {
  url: 'http://localhost:7000',
  email: process.env.ADMIN_EMAIL || 'admin@pokenic.app',
  pw: process.env.ADMIN_PASSWORD,
};
const CUST = {
  url: 'http://localhost:3000', // next dev (prod standalone build currently broken)
  email: process.env.CUSTOMER_EMAIL || 'test@polycards.app',
  pw: process.env.CUSTOMER_PASSWORD,
};

requireAdminTotp(ADMIN.email);
if (!ADMIN.pw || !CUST.pw) {
  throw new Error(
    'Set ADMIN_PASSWORD and CUSTOMER_PASSWORD before running, e.g.\n' +
      '  ADMIN_PASSWORD=… CUSTOMER_PASSWORD=… node scripts/launch-logged-in.mjs',
  );
}

// Screenshots are written here; ensure it exists so a fresh clone never fails.
mkdirSync('docs/research', { recursive: true });

const browser = await chromium.launch({ headless: false });
// One shared context = one window; each newPage() is a tab. Admin (:7000) and
// customer (:4000) are different origins, so their cookies don't collide.
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});

// --- admin (tab 1) ---
const admin = await context.newPage();
await adminUiLogin(admin, `${ADMIN.url}/dashboard`, ADMIN.email, ADMIN.pw);
await admin.screenshot({ path: 'docs/research/login-admin.png' });
console.log('✓ admin logged in →', admin.url());

// --- customer (tab 2) ---
const cust = await context.newPage();
await cust.goto(`${CUST.url}/claw/pokemon-black`, {
  waitUntil: 'domcontentloaded',
  timeout: 90000, // dev compiles the route on first hit
});
// cookie-consent banner overlays the page; accept it before interacting
await cust
  .getByRole('button', { name: /^accept$/i })
  .click({ timeout: 4000 })
  .catch(() => {});
await cust
  .getByRole('button', { name: /^login$/i })
  .first()
  .click();
await cust.fill('input[name="email"]', CUST.email);
await cust.fill('input[name="password"]', CUST.pw);
await cust.getByRole('button', { name: /^log in$/i }).click();
await cust
  .getByRole('button', { name: /open pack/i })
  .waitFor({ timeout: 60000 });
await cust.goto(`${CUST.url}/vault`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await cust.screenshot({ path: 'docs/research/login-customer.png' });
console.log('✓ customer logged in →', cust.url());

console.log('\nBoth tabs are open and logged in. Ctrl-C to close.');
await new Promise(() => {}); // keep alive
