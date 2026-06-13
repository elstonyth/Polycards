import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/hiw-entry';
fs.mkdirSync(OUT, { recursive: true });
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

// Dump the HIW section's real structure + text + check for animation hints
const dump = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h1,h2,h3')].find((e) =>
    /how it works/i.test(e.textContent),
  );
  if (!h) return { err: 'not found' };
  const sec = h.closest('section') || h.parentElement.parentElement;
  sec.setAttribute('data-hiw', '1');
  const sc = [...document.querySelectorAll('*')].find((el) => {
    const s = getComputedStyle(el);
    return (
      (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 100
    );
  });
  sc.setAttribute('data-scroller', '1');
  // grab heading area text + all step-like blocks
  const texts = [...sec.querySelectorAll('h2,h3,h4,p,span,a')]
    .map((n) => n.textContent.trim())
    .filter((t) => t && t.length < 90);
  const imgs = [...sec.querySelectorAll('img')].map(
    (i) =>
      (i.currentSrc || i.src).replace(/^https?:\/\/[^/]+/, '').split('?')[0],
  );
  // sectionTop within scroller
  const secOffsetTop = sec.offsetTop;
  return {
    texts: [...new Set(texts)].slice(0, 40),
    imgs: [...new Set(imgs)],
    secOffsetTop,
    scH: sc.clientHeight,
    html: sec.innerHTML.slice(0, 500),
  };
});
fs.writeFileSync(`${OUT}/hiw-content.json`, JSON.stringify(dump, null, 1));
console.log('TEXTS:', JSON.stringify(dump.texts));
console.log('IMGS:', JSON.stringify(dump.imgs));
console.log('secOffsetTop:', dump.secOffsetTop, 'viewportH:', dump.scH);

// Park section just BELOW the fold (so it hasn't entered yet), then scroll it in + sample fast
const parkAt = Math.max(0, dump.secOffsetTop - dump.scH - 50); // section just under bottom edge
await p.evaluate((y) => {
  document.querySelector('[data-scroller]').scrollTop = y;
}, parkAt);
await p.waitForTimeout(500);
// tag the step cards now
await p.evaluate(() => {
  const sec = document.querySelector('[data-hiw]');
  const grids = [...sec.querySelectorAll('div')].filter((d) => {
    const s = getComputedStyle(d);
    return s.display === 'grid' || s.display === 'flex';
  });
  let cards = [];
  for (const g of grids) {
    const kids = [...g.children].filter(
      (c) => c.textContent.trim().length > 10,
    );
    if (kids.length >= 2 && kids.length <= 6) {
      cards = kids;
      break;
    }
  }
  cards.forEach((c, i) => c.setAttribute('data-hc', String(i)));
});
// jump the section into view (scroll up so it enters from bottom)
const intoView = Math.max(0, dump.secOffsetTop - dump.scH * 0.5);
await p.evaluate((y) => {
  document
    .querySelector('[data-scroller]')
    .scrollTo({ top: y, behavior: 'instant' });
}, intoView);
// high-FPS sample for ~1.2s
const frames = [];
for (let i = 0; i < 24; i++) {
  const snap = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-hc]')];
    return cards.map((c) => {
      const s = getComputedStyle(c);
      return {
        o: +(+s.opacity).toFixed(2),
        tf: s.transform === 'none' ? '' : s.transform,
        anim: s.animationName,
        dur: s.animationDuration,
        trans: s.transitionDuration,
      };
    });
  });
  frames.push(snap);
  await p.waitForTimeout(50);
}
fs.writeFileSync(`${OUT}/catch.json`, JSON.stringify(frames, null, 1));
console.log('=== entry frames (card0) ===');
frames.forEach((f, i) => {
  const c = f[0] || {};
  console.log(
    'f' +
      String(i).padStart(2) +
      ': o=' +
      c.o +
      ' tf=' +
      (c.tf || 'none').slice(0, 38) +
      ' anim=' +
      c.anim +
      ' adur=' +
      c.dur +
      ' tdur=' +
      c.trans,
  );
});
await b.close();
