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

// Find the REAL scroll container (the element that actually scrolls)
const scrollerInfo = await p.evaluate(() => {
  const cands = [...document.querySelectorAll('*')]
    .filter((el) => {
      const s = getComputedStyle(el);
      return (
        (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 100
      );
    })
    .map((el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 40),
      sh: el.scrollHeight,
      ch: el.clientHeight,
    }));
  return {
    windowScrolls: document.documentElement.scrollHeight > innerHeight + 100,
    cands,
  };
});
console.log('window scrolls?', scrollerInfo.windowScrolls);
console.log('scroll containers:', JSON.stringify(scrollerInfo.cands));

// Get a handle to the scroller (first overflow container, else window)
const useMain = scrollerInfo.cands.length > 0;
// Find HIW heading + its scrollTop position within the scroller
const meta = await p.evaluate((useMain) => {
  const h = [...document.querySelectorAll('h1,h2,h3')].find((e) =>
    /how it works/i.test(e.textContent),
  );
  if (!h) return null;
  const sec = h.closest('section') || h.parentElement.parentElement;
  sec.setAttribute('data-hiw', '1');
  const scroller = useMain
    ? [...document.querySelectorAll('*')].find((el) => {
        const s = getComputedStyle(el);
        return (
          (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 100
        );
      })
    : document.scrollingElement;
  scroller.setAttribute && scroller.setAttribute('data-scroller', '1');
  // step cards
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
  return {
    heading: h.textContent.trim(),
    cardCount: cards.length,
    secTextLen: sec.innerText.length,
  };
}, useMain);
console.log('HIW:', meta.heading, '| cards:', meta.cardCount);

// Reset scroller to top, then step-scroll and sample card transforms
await p.evaluate(() => {
  const sc =
    document.querySelector('[data-scroller]') || document.scrollingElement;
  sc.scrollTop = 0;
});
await p.waitForTimeout(400);
const total = await p.evaluate(() => {
  const sc =
    document.querySelector('[data-scroller]') || document.scrollingElement;
  return sc.scrollHeight;
});

const samples = [];
for (let step = 0; step <= 40; step++) {
  const target = Math.round((total / 40) * step);
  await p.evaluate((t) => {
    const sc =
      document.querySelector('[data-scroller]') || document.scrollingElement;
    sc.scrollTop = t;
  }, target);
  await p.waitForTimeout(60);
  const snap = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-hc]')];
    return cards.map((c) => {
      const s = getComputedStyle(c);
      const r = c.getBoundingClientRect();
      return {
        o: +(+s.opacity).toFixed(2),
        tf: s.transform === 'none' ? '' : s.transform.slice(0, 40),
        top: Math.round(r.top),
        trans: s.transitionDuration,
      };
    });
  });
  samples.push({ step, scrollTop: target, cards: snap });
}
fs.writeFileSync(`${OUT}/entry2.json`, JSON.stringify(samples, null, 1));
// print only steps where card0 is near/within viewport
samples.forEach((s) => {
  const c = s.cards[0];
  if (!c) return;
  if (c.top < 1200 && c.top > -400)
    console.log(
      'st' +
        String(s.step).padStart(2) +
        ' top' +
        c.top +
        ': ' +
        s.cards
          .map((x, i) => `c${i}:o${x.o}${x.tf ? ' ' + x.tf : ''}`)
          .join(' | ') +
        ' dur=' +
        c.trans,
    );
});
await b.close();
