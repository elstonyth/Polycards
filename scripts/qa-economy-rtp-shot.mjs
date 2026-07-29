// QA: screenshot the admin Economy page Pack RTP table (markup-inclusive EV).
// Usage: node scripts/qa-economy-rtp-shot.mjs  (expects admin :7000 + backend :9000)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const envs = Object.fromEntries(
  readFileSync('scripts/.dev-logins', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto('http://localhost:7000/dashboard/login', {
    waitUntil: 'networkidle',
  });
  await page.fill(
    'input[name="email"]',
    envs.ADMIN_EMAIL ?? 'admin@pokenic.app',
  );
  await page.fill('input[name="password"]', envs.ADMIN_PW);
  await page.keyboard.press('Enter');
  await page.waitForURL(/dashboard\/(?!login)/, { timeout: 20000 });
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
