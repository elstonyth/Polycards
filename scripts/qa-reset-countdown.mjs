// Verifies the challenge hero's reset line ticks (countdown replaces the static
// "Resets Mondays 00:00 (MYT)" label after mount).
import { chromium } from 'playwright';

const base = process.env.PW_BASE ?? 'http://localhost:4000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`${base}/leaderboard`, { waitUntil: 'networkidle' });
const line = page.getByText(/^Resets/i).first();
const first = (await line.textContent())?.trim();
await page.waitForTimeout(2200);
const second = (await line.textContent())?.trim();
console.log(
  JSON.stringify({ first, second, ticking: first !== second }, null, 2),
);
await page.screenshot({ path: 'docs/research/reset-countdown.png' });
await browser.close();
// Non-zero so this can gate unattended, like the other qa-*.mjs scripts.
process.exitCode = first && second && first !== second ? 0 : 1;
