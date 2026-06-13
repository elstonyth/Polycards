import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
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
const read = () =>
  p.evaluate(() => {
    const c = getComputedStyle(
      document.querySelector('[data-tc]').firstElementChild,
    );
    return { translate: c.translate, scale: c.scale };
  });
const before = await read();
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
const after = await read();
console.log('before:', JSON.stringify(before));
console.log('after :', JSON.stringify(after));
const changed = JSON.stringify(before) !== JSON.stringify(after);
console.log(
  'RESULT:',
  changed
    ? 'PASS - card lifts/scales on hover (translate/scale change)'
    : 'FAIL',
);
await b.close();
