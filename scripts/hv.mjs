import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const client = await ctx.newCDPSession(p);
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
const sel = await p.evaluate(() => {
  const o = [...document.querySelectorAll("a[href='/claw'] div")].filter(
    (e) =>
      getComputedStyle(e).pointerEvents === 'auto' && e.querySelector('img'),
  );
  const c = o.find((e) => e.className.includes('hover:'));
  if (c) {
    c.setAttribute('data-tc', '1');
    return '[data-tc]';
  }
  return null;
});
if (!sel) {
  console.log('no hover card found');
  process.exit(0);
}
const read = () =>
  p.evaluate(() => {
    const c = getComputedStyle(document.querySelector('[data-tc]'));
    return c.translate + ' | ' + c.scale;
  });
const before = await read();
const dom = await client.send('DOM.getDocument');
const q = await client.send('DOM.querySelector', {
  nodeId: dom.root.nodeId,
  selector: sel,
});
await client.send('CSS.enable');
await client.send('CSS.forcePseudoState', {
  nodeId: q.nodeId,
  forcedPseudoClasses: ['hover'],
});
await p.waitForTimeout(350);
const after = await read();
console.log('BEFORE:', before);
console.log('AFTER :', after);
console.log(
  'VERDICT:',
  before !== after ? 'PASS - card lifts on its own hover' : 'FAIL',
);
await b.close();
