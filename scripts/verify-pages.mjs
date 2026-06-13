import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/playwright';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, url] of [
  ['home', 'http://localhost:4000/'],
  ['howitworks', 'http://localhost:4000/how-it-works'],
]) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    bypassCSP: true,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  for (let y = 0; y < 3000; y += 400) {
    await page.evaluate((v) => scrollTo(0, v), y);
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(600);
  const stat = await page.evaluate(() => {
    const i = [...document.images];
    return {
      total: i.length,
      broken: i.filter((x) => x.complete && x.naturalWidth === 0).length,
    };
  });
  await page.screenshot({ path: `${OUT}/verify-${name}.png`, fullPage: true });
  console.log(`${name}: imgs=${stat.total} broken=${stat.broken}`);
  await ctx.close();
}
await browser.close();
