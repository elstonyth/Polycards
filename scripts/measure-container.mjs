import { chromium } from 'playwright';
const b = await chromium.launch();

async function measure(url, label, waitContent) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (waitContent) {
    for (let i = 0; i < 25; i++) {
      if (await p.evaluate(() => document.images.length > 5)) break;
      await p.waitForTimeout(1000);
    }
  }
  await p.waitForTimeout(2500);
  const data = await p.evaluate(() => {
    // find the hero CONTAINER: the rounded box at the top holding the cards + headline
    const imgs = [...document.querySelectorAll('img')].filter((im) => {
      const r = im.getBoundingClientRect();
      return (
        r.top < 560 &&
        r.x > 500 &&
        r.width > 60 &&
        /ripped-packs|slabs/.test(im.src)
      );
    });
    // climb from a card img to the bordered/rounded hero container
    let box = null;
    if (imgs[0]) {
      let el = imgs[0];
      for (let d = 0; d < 12 && el; d++) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (
          (cs.borderRadius !== '0px' ||
            cs.backgroundColor !== 'rgba(0, 0, 0, 0)') &&
          r.width > 900 &&
          r.height > 300
        ) {
          box = {
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 60),
            w: Math.round(r.width),
            h: Math.round(r.height),
            top: Math.round(r.top),
            radius: cs.borderRadius,
          };
          break;
        }
        el = el.parentElement;
      }
    }
    // center (sharpest, full-opacity) card pack image size
    const cards = imgs.map((im) => {
      const r = im.getBoundingClientRect();
      let w = im.parentElement,
        wc = getComputedStyle(w),
        d = 0;
      while (w && d < 4 && wc.transform === 'none') {
        w = w.parentElement;
        wc = getComputedStyle(w);
        d++;
      }
      return {
        src: im.src.split('/').pop(),
        h: Math.round(r.height),
        w: Math.round(r.width),
        bottom: Math.round(r.bottom),
        top: Math.round(r.top),
        wOp: +(+wc.opacity).toFixed(2),
      };
    });
    const center = cards
      .filter((c) => c.wOp > 0.9)
      .sort((a, b) => b.h - a.h)[0];
    return { container: box, centerCard: center, allCards: cards.length };
  });
  console.log(`\n=== ${label} ===`);
  console.log('container:', JSON.stringify(data.container));
  console.log('center card:', JSON.stringify(data.centerCard));
  await p.close();
  return data;
}

await measure('https://www.phygitals.com/', 'ORIGINAL', true);
await measure('http://localhost:4000/', 'CLONE', false);
await b.close();
