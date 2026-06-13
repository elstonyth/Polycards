import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
const p = await ctx.newPage();
const client = await ctx.newCDPSession(p);
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
// reducedMotion: no rotation, center card is stable = THEMES[0]
const sel = await p.evaluate(() => {
  const o = [...document.querySelectorAll('[class*="group/card"]')].find(
    (e) => getComputedStyle(e).pointerEvents === 'auto',
  );
  o.setAttribute('data-test-card', '1');
  return '[data-test-card]';
});
const before = await p.evaluate(
  () =>
    getComputedStyle(
      document.querySelector('[data-test-card]').firstElementChild,
    ).transform,
);
// force :hover via CDP on the outer node
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
await p.waitForTimeout(400);
const after = await p.evaluate(
  () =>
    getComputedStyle(
      document.querySelector('[data-test-card]').firstElementChild,
    ).transform,
);
console.log('before :hover ->', before);
console.log('after  :hover ->', after);
console.log(
  'RESULT:',
  before !== after && after !== 'none'
    ? 'PASS — group-hover/card lift works'
    : 'still none',
);
await b.close();
