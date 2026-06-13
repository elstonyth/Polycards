import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await p.evaluate(() => document.images.length > 5)) break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(2500);
const d = await p.evaluate(() => {
  // climb from the "Rip packs" headline up to the full hero container
  const h = [...document.querySelectorAll('h1,h2')].find((e) =>
    e.textContent.includes('Rip packs'),
  );
  const chain = [];
  let el = h;
  for (let i = 0; i < 8 && el; i++) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    chain.push({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 45),
      x: Math.round(r.x),
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: cs.borderRadius,
      mw: cs.maxWidth,
    });
    el = el.parentElement;
  }
  return chain;
});
d.forEach((c, i) => console.log(i + ': ' + JSON.stringify(c)));
await b.close();
