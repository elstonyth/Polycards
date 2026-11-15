// One-off Playwright capture of the admin P&L page (Payments → P&L).
// Usage: node scripts/capture-pnl.mjs
// Requires backend :9000 + admin :7000 up; ADMIN_PW and QA_ADMIN_TOTP_SECRET in
// env or scripts/.dev-logins (read here, never printed). Shots → docs/research/pnl/.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
const OUT = process.env.OUT_DIR || 'docs/research/pnl';
mkdirSync(OUT, { recursive: true });

function devLogin(key, fallback) {
  if (process.env[key]) return process.env[key];
  const f = 'scripts/.dev-logins';
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return fallback;
}
// admin-sign-in reads the TOTP secret at import, so set it first.
const totp = devLogin('QA_ADMIN_TOTP_SECRET', '');
if (totp) process.env.QA_ADMIN_TOTP_SECRET = totp;
const { adminUiLogin, requireAdminTotp } =
  await import('./lib/admin-sign-in.mjs');
const EMAIL = devLogin('ADMIN_EMAIL', 'admin@pokenic.app');
const PW = devLogin('ADMIN_PW', '');
requireAdminTotp(EMAIL);
if (!PW) {
  console.error('No ADMIN_PW found (env or scripts/.dev-logins)');
  process.exit(1);
}

const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('response', (r) => {
    if (r.url().includes('/admin/profit-report/pnl'))
      console.log('pnl api', r.status(), r.url().split('?')[1]);
  });
  await adminUiLogin(page, BASE, EMAIL, PW);
  for (const [name, range] of [
    ['month', null],
    ['all', 'All time'],
  ]) {
    await page.goto(`${BASE}/pnl`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page
      .getByRole('heading', { name: 'P&L', level: 1 })
      .waitFor({ timeout: 30000 });
    if (range)
      await page
        .getByRole('button', { name: range })
        .first()
        .click()
        .catch(() => {});
    await page.waitForTimeout(4000); // vite dev never reaches networkidle
    await page.screenshot({
      path: path.join(OUT, `pnl-${name}-1440.png`),
      fullPage: true,
    });
    console.log('shot', name);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${BASE}/pnl`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.screenshot({
    path: path.join(OUT, 'pnl-month-390.png'),
    fullPage: true,
  });
  console.log('shot mobile');
  const nav = await page.getByText('P&L', { exact: true }).count();
  console.log('nav entries named P&L:', nav);
} finally {
  await browser.close();
  console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');
}
