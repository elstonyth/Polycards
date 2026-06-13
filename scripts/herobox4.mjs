import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const out = {};
async function m(url, label, wait) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (wait) {
    for (let i = 0; i < 25; i++) {
      if (await p.evaluate(() => document.images.length > 5)) break;
      await p.waitForTimeout(1000);
    }
  }
  await p.waitForTimeout(2500);
  out[label] = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h1,h2')].find((e) =>
      e.textContent.includes('Rip packs'),
    );
    // climb to outermost element that still has the rounded hero radius
    let hero = h,
      last = null;
    for (let i = 0; i < 10 && hero; i++) {
      const cs = getComputedStyle(hero);
      const r = hero.getBoundingClientRect();
      if (r.height >= 400 && r.height <= 560 && parseFloat(cs.borderRadius) > 8)
        last = {
          x: Math.round(r.x),
          right: Math.round(r.right),
          w: Math.round(r.width),
          h: Math.round(r.height),
          radius: cs.borderRadius,
        };
      hero = hero.parentElement;
    }
    const body = document.body.getBoundingClientRect();
    return {
      hero: last,
      bodyW: Math.round(body.width),
      viewport: window.innerWidth,
    };
  });
  await p.close();
}
await m('https://www.phygitals.com/', 'ORIGINAL', true);
await m('http://localhost:4000/', 'CLONE', false);
fs.writeFileSync('docs/research/herobox.json', JSON.stringify(out, null, 2));
await b.close();
