import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);
await p.screenshot({
  path: 'docs/research/CLONE_HERO_WIDE.png',
  clip: { x: 0, y: 0, width: 1440, height: 600 },
});
await b.close();
