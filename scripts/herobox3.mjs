import { chromium } from 'playwright';
const b = await chromium.launch();

async function trace(url, label, wait) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (wait) {
    for (let i = 0; i < 25; i++) {
      if (await p.evaluate(() => document.images.length > 5)) break;
      await p.waitForTimeout(1000);
    }
  }
  await p.waitForTimeout(2500);
  const d = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h1,h2')].find((e) =>
      e.textContent.includes('Rip packs'),
    );
    if (!h) return [{ err: 'no headline' }];
    const chain = [];
    let el = h;
    for (let i = 0; i < 9 && el; i++) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      chain.push({
        tag: el.tagName,
        x: Math.round(r.x),
        w: Math.round(r.width),
        h: Math.round(r.height),
        radius: cs.borderRadius,
        mw: cs.maxWidth,
        px: cs.paddingLeft,
      });
      el = el.parentElement;
    }
    return chain;
  });
  console.log(`\n=== ${label} ===`);
  d.forEach((c, i) => console.log(i + ': ' + JSON.stringify(c)));
  await p.close();
}

await trace('https://www.phygitals.com/', 'ORIGINAL', true);
await trace('http://localhost:4000/', 'CLONE', false);
await b.close();
