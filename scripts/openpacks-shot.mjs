import { firefox } from 'playwright';
const b = await firefox.launch();
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const p = await ctx.newPage();
await p.goto('http://localhost:4000/', {
  waitUntil: 'networkidle',
  timeout: 60000,
});
await p.waitForTimeout(1500);
// Open Packs section
const h = p.locator('h2', { hasText: 'Open Packs' }).first();
await h.scrollIntoViewIfNeeded();
await p.waitForTimeout(800);
const section = h.locator('xpath=ancestor::section').first();
await section.screenshot({ path: 'docs/playwright/openpacks.png' });
// Hero
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(800);
await p
  .locator('section')
  .first()
  .screenshot({ path: 'docs/playwright/hero.png' });
console.log('saved openpacks.png + hero.png');
await b.close();
