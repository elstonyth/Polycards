// Challenge route capture: logs in, shots /dashboard/challenge, counts controls.
// Usage: node scripts/challenge-ux-shot.mjs before|after
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
await page.waitForURL(/dashboard/, { timeout: 30000 });
await page.waitForTimeout(1500);

await page.goto(`${BASE}/dashboard/challenge`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/ch-${tag}-top.png` });

const metrics = async () =>
  page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll(
        'button, input, select, textarea, [role="combobox"], [role="switch"]',
      ),
    ).filter((e) => e.getBoundingClientRect().height > 0);
    return {
      controls: els.length,
      inputs: els.filter((e) => e.tagName === 'INPUT').length,
      rows: document.querySelectorAll('tbody tr').length,
      docHeight: document.documentElement.scrollHeight,
    };
  });
console.log('collapsed/default', tag, JSON.stringify(await metrics()));

await page.mouse.wheel(0, 1200);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/ch-${tag}-mid.png` });

// Expand every stage disclosure, if present.
const toggles = page.locator('[data-pc-stage-toggle]');
const n = await toggles.count();
for (let i = 0; i < n; i++) {
  const t = toggles.nth(i);
  if ((await t.getAttribute('aria-expanded')) === 'false') await t.click();
}
if (n) {
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/ch-${tag}-expanded.png` });
  console.log('all expanded', tag, JSON.stringify(await metrics()));
}

await browser.close();
