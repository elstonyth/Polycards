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
const header = p.locator('header').first();
await header.screenshot({ path: 'docs/playwright/firefox-header.png' });
console.log('saved docs/playwright/firefox-header.png');
await b.close();
