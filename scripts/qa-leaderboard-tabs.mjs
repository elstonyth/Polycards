// One-off QA capture: /leaderboard This Week + All Time tabs (mobile viewport).
// Dismisses the cookie banner and captures just the leaderboard block.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR ?? 'docs/research';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 1200 },
  deviceScaleFactor: 2,
});
await page.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle' });
const accept = page.getByRole('button', { name: 'Accept' });
if (await accept.isVisible().catch(() => false)) await accept.click();
await page.waitForTimeout(800);

const block = page.locator('div.px-fluid.mx-auto.w-full.max-w-md.pt-6').first();
await block.screenshot({ path: `${OUT}/leaderboard-this-week.png` });

await page.getByRole('button', { name: 'All Time' }).click();
await page.waitForTimeout(600);
await block.screenshot({ path: `${OUT}/leaderboard-all-time.png` });

await browser.close();
console.log('done');
