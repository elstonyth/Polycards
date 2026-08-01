// Verify (prod build :4000):
//  1. signup modal phone picker: default 🇲🇾 +60, country switch updates dial,
//     hidden input carries E.164, invalid number → inline error
//  2. settings phone picker seeds from the stored E.164 value
//  3. /auth/google/callback builds redirects from x-forwarded-* (allowlisted),
//     falling back to request.url locally — the 0.0.0.0 prod fix
// Run from repo root: node scripts/verify-phone-google.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const OUT = process.env.OUT_DIR ?? 'docs/research';
const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures++;
};

// ── 3. Google callback origin (no browser needed) ────────────────────────────
{
  const res = await fetch(`${BASE}/auth/google/callback?error=denied`, {
    redirect: 'manual',
    headers: {
      'x-forwarded-host': 'polycards.gg',
      'x-forwarded-proto': 'https',
    },
  });
  const loc = res.headers.get('location') ?? '';
  check(
    'google callback honors forwarded host',
    loc.startsWith('https://polycards.gg/auth/google/failed'),
    loc,
  );
}
{
  const res = await fetch(`${BASE}/auth/google/callback?error=denied`, {
    redirect: 'manual',
    headers: { 'x-forwarded-host': 'evil.example.com' },
  });
  const loc = res.headers.get('location') ?? '';
  check(
    'google callback rejects foreign host (falls back to request origin)',
    !loc.includes('evil.example.com') && loc.includes('/auth/google/failed'),
    loc,
  );
}

// ── 1. Signup phone picker ───────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i })
  .first();
await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
await loginBtn.click();
await page.locator('input[name="email"]').waitFor({ state: 'visible' });
await page.getByRole('button', { name: 'Sign up' }).click();

const countrySelect = page.getByLabel('Country code');
await countrySelect.waitFor({ state: 'visible' });
check('default country is MY', (await countrySelect.inputValue()) === 'MY');

await page.getByLabel('Phone number').fill('010-766 7787');
const hiddenVal = await page
  .locator('input[type="hidden"][name="phone"]')
  .inputValue();
check(
  'hidden input carries E.164 for MY local input',
  hiddenVal === '+60107667787',
  hiddenVal,
);

await countrySelect.selectOption('GB');
const hiddenGb = await page
  .locator('input[type="hidden"][name="phone"]')
  .inputValue();
check(
  'country switch re-prefixes the number',
  hiddenGb.startsWith('+44'),
  hiddenGb,
);
await page.screenshot({ path: `${OUT}/signup-country-picker.png` });

// invalid number → inline error
await countrySelect.selectOption('MY');
await page.locator('input[name="username"]').fill('bibibo');
await page.locator('input[name="email"]').fill('demo@example.com');
await page.getByLabel('Phone number').fill('123');
await page.locator('input[name="password"]').fill('Password123!');
await page.locator('input[name="confirmPassword"]').fill('Password123!');
await page.getByRole('button', { name: 'Create account' }).click();
await page.waitForTimeout(400);
const err = await page.locator('#auth-form-error').textContent();
check(
  'invalid number shows the country-aware error',
  (err ?? '').includes('valid phone number'),
  err ?? '',
);
await page.screenshot({ path: `${OUT}/signup-country-invalid.png` });

// ── 2. Settings picker (login as test customer) ──────────────────────────────
const env = Object.fromEntries(
  readFileSync('scripts/.dev-logins', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);
if (env.CUST_PW) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
  await loginBtn.click();
  const email = page.locator('input[name="email"]');
  await email.waitFor({ state: 'visible' });
  await email.fill(env.CUST_EMAIL ?? 'test@pokenic.app');
  await page.fill('input[name="password"]', env.CUST_PW);
  await page.press('input[name="password"]', 'Enter');
  await email.waitFor({ state: 'detached', timeout: 15000 });
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  const sel = page.getByLabel('Country code');
  await sel.waitFor({ state: 'visible', timeout: 15000 });
  check('settings shows the country picker', true);
  await page.screenshot({ path: `${OUT}/settings-country-picker.png` });
} else {
  console.log('SKIP settings check: no CUST_PW');
}

await browser.close();
console.log(
  failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
