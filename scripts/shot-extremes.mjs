import { chromium } from 'playwright';
const b = await chromium.launch();
// minimized
let p = await b.newPage({ viewport: { width: 380, height: 820 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1200);
await p.screenshot({
  path: 'docs/research/FLUID_min380.png',
  clip: { x: 0, y: 0, width: 380, height: 740 },
});
await p.close();
// 4K
p = await b.newPage({ viewport: { width: 3840, height: 2160 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
await p.screenshot({
  path: 'docs/research/FLUID_4k.png',
  clip: { x: 0, y: 0, width: 3840, height: 1200 },
});
await p.close();
await b.close();
console.log('done');
