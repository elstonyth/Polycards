import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);

// grab the center card's inner (response) div handle directly, then hover its OUTER
async function getEls() {
  return p.evaluateHandle(() => {
    const outer = [...document.querySelectorAll('[class*="group/card"]')].find(
      (e) => getComputedStyle(e).pointerEvents === 'auto',
    );
    return outer;
  });
}
// read transform of inner child of current center card
async function innerTf() {
  return p.evaluate(() => {
    const o = [...document.querySelectorAll('[class*="group/card"]')].find(
      (e) => getComputedStyle(e).pointerEvents === 'auto',
    );
    return o ? getComputedStyle(o.firstElementChild).transform : 'none';
  });
}

// Test A: hover the headline (text area) — should NOT lift
await p.locator("h2:has-text('Rip packs')").hover();
await p.waitForTimeout(400);
const offText = await innerTf();

// Test B: hover the center card's OUTER group div directly
const outer = await getEls();
await outer.hover().catch(() => {});
await p.waitForTimeout(400);
const onCard = await innerTf();

console.log('hover headline -> inner transform:', offText);
console.log('hover card     -> inner transform:', onCard);
console.log(
  'RESULT:',
  offText === 'none' && onCard !== 'none'
    ? 'PASS (card lifts only on card hover)'
    : offText !== onCard
      ? 'PARTIAL (differs)'
      : 'FAIL (no change)',
);
await b.close();
