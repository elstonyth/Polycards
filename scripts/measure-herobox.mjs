import { chromium } from 'playwright';
const b = await chromium.launch();
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
  const d = await p.evaluate(() => {
    // the hero is the <a> rounded box near the top holding the headline+cards
    const a = [...document.querySelectorAll('a')].find((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.top < 200 &&
        r.width > 900 &&
        r.height > 300 &&
        getComputedStyle(el).borderRadius !== '0px'
      );
    });
    if (!a) return { err: 'no hero' };
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    // also the page content wrapper width (parent chain max-width)
    let wrap = a.parentElement,
      ww = 0;
    for (let i = 0; i < 6 && wrap; i++) {
      const wr = wrap.getBoundingClientRect();
      if (wr.width > r.width) {
        ww = Math.round(wr.width);
        break;
      }
      wrap = wrap.parentElement;
    }
    return {
      x: Math.round(r.x),
      right: Math.round(r.right),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      radius: cs.borderRadius,
      wrapW: ww,
    };
  });
  console.log(label + ': ' + JSON.stringify(d));
  await p.close();
}
await m('https://www.phygitals.com/', 'ORIGINAL', true);
await m('http://localhost:4000/', 'CLONE', false);
await b.close();
