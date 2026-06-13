import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1000 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(1200);
const h = await p.evaluate(() => document.body.scrollHeight);
await p.screenshot({
  path: 'docs/research/CLONE_FOOTER.png',
  clip: { x: 0, y: Math.max(0, h - 440), width: 1920, height: 440 },
});
const d = await p.evaluate(() => {
  const ql = [...document.querySelectorAll('*')].find(
    (e) => e.textContent.trim() === 'Quick Links',
  );
  let el = ql,
    inner = null;
  for (let i = 0; i < 8 && el; i++) {
    const r = el.getBoundingClientRect();
    if (r.width > 700) {
      inner = { w: Math.round(r.width), x: Math.round(r.x) };
      break;
    }
    el = el.parentElement;
  }
  return inner;
});
console.log('CLONE footer inner @1920:', JSON.stringify(d));
await b.close();
