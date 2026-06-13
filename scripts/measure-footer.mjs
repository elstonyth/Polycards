import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1000 } });
await p.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await p.evaluate(() => document.images.length > 5)) break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(2500);
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(1500);
const d = await p.evaluate(() => {
  const f = document.querySelector('footer');
  if (!f) return { err: 'no footer' };
  const fr = f.getBoundingClientRect();
  // the inner content container (Quick Links etc.)
  const ql = [...f.querySelectorAll('*')].find(
    (e) => e.textContent.trim() === 'Quick Links',
  );
  let inner = null;
  if (ql) {
    let el = ql;
    for (let i = 0; i < 8 && el && el !== f; i++) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 700) {
        inner = {
          w: Math.round(r.width),
          x: Math.round(r.x),
          mw: cs.maxWidth,
          px: cs.paddingLeft,
        };
        break;
      }
      el = el.parentElement;
    }
  }
  return { footerW: Math.round(fr.width), footerX: Math.round(fr.x), inner };
});
console.log('ORIGINAL footer @1920:', JSON.stringify(d));
await b.close();
