import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:4000/', {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  h && h.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(1200);
const broken = await page.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
await page.screenshot({
  path: 'docs/playwright/openpacks-fixed.png',
  clip: { x: 0, y: 0, width: 1440, height: 760 },
});
console.log('broken:', broken);
await browser.close();
