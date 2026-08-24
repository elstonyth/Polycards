// One-off QA capture of the /task hub (referral rebuild). Screenshots the
// logged-out state of all three tabs against the standalone server.
// Usage: PW_BASE=http://localhost:4100 node scripts/qa-task-hub.mjs
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const OUT = 'docs/research';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`${BASE}/task`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/task-hub-tasks.png`, fullPage: true });

await page.getByRole('tab', { name: /referral/i }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/task-hub-referral.png`, fullPage: true });

await page.getByRole('tab', { name: /vip/i }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/task-hub-vip.png`, fullPage: true });

console.log('captured 3 screenshots');
await browser.close();
