// Admin settlement page smoke: logs in with scripts/.dev-logins, screenshots the
// Gateway audit panel (plan 130) to docs/research/tgpay-admin-settlement.png.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const raw = fs.readFileSync('scripts/.dev-logins', 'utf8');
const env = Object.fromEntries(raw.split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const ADMIN = 'http://localhost:7000/dashboard';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', env.ADMIN_EMAIL || 'admin@pokenic.app');
await page.fill('input[name="password"]', env.ADMIN_PW);
await page.press('input[name="password"]', 'Enter');
await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30000 });
await page.goto(`${ADMIN}/settlement`, { waitUntil: 'domcontentloaded' });
await page.getByText('Gateway audit').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: 'docs/research/tgpay-admin-settlement.png', fullPage: true });
console.log(await page.locator('text=Gateway audit').count(), 'audit heading(s);', 'findings badge:', await page.getByText(/agrees with every audited row|disagrees with/).first().innerText().catch(() => 'n/a'));
await browser.close();
