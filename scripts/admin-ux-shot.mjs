// Admin UX capture: logs in and screenshots the custom routes.
// Usage: node scripts/admin-ux-shot.mjs before|after
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const tag = process.argv[2] || 'shot';
const BASE = 'http://localhost:7001';
const OUT = 'docs/research';
mkdirSync(OUT, { recursive: true });

const routes = [
  { name: 'daily-rewards', path: '/dashboard/daily-rewards' },
  { name: 'challenge', path: '/dashboard/challenge' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', 'admin@pokenic.app');
await page.fill('input[name="password"]', 'PreviewOnly2026!');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });
await page.waitForTimeout(2000);

for (const r of routes) {
  await page.goto(`${BASE}${r.path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  // The VIP ladder lives behind a tab on daily-rewards.
  if (r.name === 'daily-rewards') {
    const tab = page.getByRole('tab', { name: /vip/i });
    if (await tab.count()) {
      await tab.first().click();
      await page.waitForTimeout(1500);
    }
  }
  await page.screenshot({ path: `${OUT}/admin-${r.name}-${tag}-top.png` });

  // Mid-scroll: proves whether a save bar is pinned to the viewport.
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/admin-${r.name}-${tag}-mid.png` });

  // Open one row-actions menu so the overflow menu is visible in the capture.
  const menuBtn = page.locator('[aria-label^="Actions for"]');
  if (await menuBtn.count()) {
    await menuBtn.nth(3).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/admin-${r.name}-${tag}-menu.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  const metrics = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll(
        'button, input, select, textarea, [role="combobox"], [role="switch"]',
      ),
    );
    const vis = els.filter((e) => e.getBoundingClientRect().height > 0);
    return {
      controls: vis.length,
      inputs: vis.filter((e) => e.tagName === 'INPUT').length,
      under32: vis.filter((e) => e.getBoundingClientRect().height < 32).length,
      dangerButtons: vis.filter((e) =>
        /bg-ui-button-danger/.test(e.className || ''),
      ).length,
    };
  });
  console.log(r.name, tag, JSON.stringify(metrics));
}

await browser.close();
