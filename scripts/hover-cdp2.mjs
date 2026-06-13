import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); // motion ON
const p = await ctx.newPage();
const client = await ctx.newCDPSession(p);
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
const sel = await p.evaluate(() => {
  const o = [...document.querySelectorAll('[class*="group/card"]')].find(
    (e) => getComputedStyle(e).pointerEvents === 'auto',
  );
  o.setAttribute('data-tc', '1');
  return '[data-tc]';
});
const before = await p.evaluate(
  () =>
    getComputedStyle(document.querySelector('[data-tc]').firstElementChild)
      .transform,
);
const { root } = await client.send('DOM.getDocument');
const { nodeId } = await client.send('DOM.querySelector', {
  nodeId: root.nodeId,
  selector: sel,
});
await client.send('CSS.enable');
await client.send('CSS.forcePseudoState', {
  nodeId,
  forcedPseudoClasses: ['hover'],
});
await p.waitForTimeout(350);
const after = await p.evaluate(
  () =>
    getComputedStyle(document.querySelector('[data-tc]').firstElementChild)
      .transform,
);
console.log('before:', before);
console.log('after :', after);
console.log(
  'RESULT:',
  before !== after && after !== 'none' ? 'PASS - card lifts on hover' : 'FAIL',
);
await b.close();
