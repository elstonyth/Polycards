import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2500);
// inner response div = child of group/card with pointer-events auto
async function innerTf() {
  return p.evaluate(() => {
    const outer = [...document.querySelectorAll('[class*="group/card"]')].find(
      (e) => getComputedStyle(e).pointerEvents === 'auto',
    );
    if (!outer) return 'no-card';
    const inner = outer.firstElementChild;
    return getComputedStyle(inner).transform;
  });
}
await p.mouse.move(200, 300);
await p.waitForTimeout(500);
const off = await innerTf();
await p.mouse.move(1090, 330);
await p.waitForTimeout(500);
const on = await innerTf();
console.log('OFF-card (hover text):', off);
console.log('ON-card  (hover card):', on);
console.log(
  'RESULT:',
  off !== on ? 'PASS - only card lifts on card-hover' : 'FAIL',
);
await b.close();
