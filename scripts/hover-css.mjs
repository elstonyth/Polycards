import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);
const info = await p.evaluate(() => {
  const outer = [...document.querySelectorAll('[class*="group/card"]')].find(
    (e) => getComputedStyle(e).pointerEvents === 'auto',
  );
  if (!outer) return { err: 'no center card' };
  const inner = outer.firstElementChild;
  const r = outer.getBoundingClientRect();
  return {
    outerCls: outer.className,
    innerCls: inner.className,
    outerBox: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    innerTransition: getComputedStyle(inner).transitionProperty,
  };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
