import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:4000/how-it-works', {
  waitUntil: 'load',
  timeout: 60000,
});
for (let y = 0; y < 4000; y += 400) {
  await page.evaluate((v) => scrollTo(0, v), y);
  await page.waitForTimeout(200);
}
await page.waitForTimeout(800);
const broken = await page.evaluate(() =>
  [...document.images]
    .filter((x) => x.complete && x.naturalWidth === 0)
    .map((x) => new URL(x.src).pathname),
);
console.log(JSON.stringify(broken, null, 1));
await browser.close();
