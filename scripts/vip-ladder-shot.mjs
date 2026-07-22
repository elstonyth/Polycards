// VIP ladder (daily-rewards > Levels) capture + control census.
// Usage: node scripts/vip-ladder-shot.mjs before|after
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const tag = process.argv[2] || 'shot';
const BASE = 'http://localhost:7001';
const OUT = 'docs/research';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', 'admin@pokenic.app');
await page.fill('input[name="password"]', 'PreviewOnly2026!');
await page.click('button[type="submit"]');
await page.waitForURL(
  (u) => /dashboard/.test(String(u)) && !/login/.test(String(u)),
  { timeout: 30000 },
);
await page.goto(`${BASE}/dashboard/daily-rewards`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(4000);

const census = async () =>
  page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll(
        'button, input, select, textarea, [role="combobox"], [role="switch"]',
      ),
    ).filter((e) => e.checkVisibility());
    return {
      controls: els.length,
      inputs: els.filter((e) => e.tagName === 'INPUT').length,
      pageHeight: document.documentElement.scrollHeight,
      scrollerHeight: Math.max(
        ...Array.from(document.querySelectorAll('*')).map(
          (e) => e.scrollHeight,
        ),
      ),
    };
  });

console.log(tag, 'collapsed/default', JSON.stringify(await census()));
await page.screenshot({ path: `${OUT}/vip-${tag}-top.png` });
await page.mouse.wheel(0, 2200);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/vip-${tag}-mid.png` });

// After-only: expand everything to prove bulk edit still reachable.
const expandAll = page.getByRole('button', { name: /expand all/i });
if (await expandAll.count()) {
  await page.mouse.wheel(0, -5000);
  await expandAll.first().click();
  await page.waitForTimeout(800);
  console.log(tag, 'expanded-all', JSON.stringify(await census()));
  await page.screenshot({ path: `${OUT}/vip-${tag}-expanded.png` });
}
await browser.close();
