import { firefox } from 'playwright';
const b = await firefox.launch();
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
});
const p = await ctx.newPage();
await p.goto('http://localhost:4000/', {
  waitUntil: 'networkidle',
  timeout: 60000,
});
await p.waitForTimeout(1500);
// scroll so Open Packs row is in view, screenshot the viewport (not element clip)
await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  if (h) h.scrollIntoView({ block: 'start' });
});
await p.waitForTimeout(1200);
await p.screenshot({ path: 'docs/playwright/packs-view.png' });
console.log('saved packs-view.png');
await b.close();
