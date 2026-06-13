import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// does the original have a /how-it-works page?
const res = await p
  .goto('https://www.phygitals.com/how-it-works', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  .catch((e) => ({ status: () => 'ERR' }));
console.log('how-it-works status:', res && res.status ? res.status() : '?');
await p.waitForTimeout(3000);
const info = await p.evaluate(() => {
  const h1 = [...document.querySelectorAll('h1,h2')]
    .map((e) => e.textContent.trim())
    .slice(0, 6);
  // find the real scroller
  const sc = [...document.querySelectorAll('*')].find((el) => {
    const s = getComputedStyle(el);
    return (
      (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 100
    );
  });
  return {
    headings: h1,
    hasScroller: !!sc,
    title: document.title,
    url: location.pathname,
  };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
