// QA: screenshot the admin Economy page Pack RTP table (markup-inclusive EV).
// Usage: node scripts/qa-economy-rtp-shot.mjs  (expects admin :7000 + backend :9000)
import { chromium } from 'playwright';
import { adminUiLogin, requireAdminTotp } from './lib/admin-sign-in.mjs';
import { readFileSync } from 'node:fs';

const envs = Object.fromEntries(
  readFileSync('scripts/.dev-logins', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const ADMIN_EMAIL = envs.ADMIN_EMAIL ?? 'admin@pokenic.app';
requireAdminTotp(ADMIN_EMAIL);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await adminUiLogin(
    page,
    'http://localhost:7000/dashboard',
    ADMIN_EMAIL,
    envs.ADMIN_PW,
  );
  await page.goto('http://localhost:7000/dashboard/economy', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: 'docs/research/economy-rtp-markup.png',
    fullPage: true,
  });
} finally {
  await browser.close();
}
console.log('done');
