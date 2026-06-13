import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2500);
await p.screenshot({
  path: 'docs/research/CLONE_FINAL.png',
  clip: { x: 0, y: 0, width: 1440, height: 560 },
});
// stable hover test: read the CENTER card wrapper translateY (not slab top, to avoid rotation noise)
async function cardTY() {
  return p.evaluate(() => {
    const d = [...document.querySelectorAll('[class*="group/card"]')].find(
      (e) => getComputedStyle(e).pointerEvents === 'auto',
    );
    if (!d) return null;
    const m = getComputedStyle(d).transform;
    return m;
  });
}
await p.mouse.move(200, 300);
await p.waitForTimeout(500);
const offCard = await cardTY();
await p.mouse.move(1090, 330);
await p.waitForTimeout(500);
const onCard = await cardTY();
console.log('transform OFF-card (hover text):', offCard);
console.log('transform ON-card  (hover card):', onCard);
console.log(
  'hover scoped correctly:',
  offCard !== onCard ? 'YES (only card reacts)' : 'NO',
);
await b.close();
