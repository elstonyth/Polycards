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

// Find the "How It Works" heading and its section
const found = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h1,h2,h3')].find((e) =>
    /how it works/i.test(e.textContent),
  );
  if (!h) return null;
  const sec = h.closest('section') || h.parentElement.parentElement;
  sec.setAttribute('data-hiw', '1');
  const top = sec.getBoundingClientRect().top + window.scrollY;
  return { top: Math.round(top), text: h.textContent.trim() };
});
if (!found) {
  console.log('HIW NOT FOUND');
  await b.close();
  process.exit(0);
}
console.log('HIW heading:', found.text, 'docTop:', found.top);

// Park well above it, then scroll it into view in steps, sampling the step-cards' transform+opacity
await p.evaluate((t) => window.scrollTo(0, t - 950), found.top);
await p.waitForTimeout(600);

// identify the step cards inside the section
const cardInfo = await p.evaluate(() => {
  const sec = document.querySelector('[data-hiw]');
  // candidate cards = direct grid children that contain text
  const grids = [...sec.querySelectorAll('div')].filter((d) => {
    const s = getComputedStyle(d);
    return s.display === 'grid' || s.display === 'flex';
  });
  // pick the container with 3+ children that look like cards
  let cards = [];
  for (const g of grids) {
    const kids = [...g.children].filter(
      (c) => c.textContent.trim().length > 10,
    );
    if (kids.length >= 2 && kids.length <= 5) {
      cards = kids;
      break;
    }
  }
  cards.forEach((c, i) => c.setAttribute('data-hiwcard', String(i)));
  return {
    count: cards.length,
    transitions: cards.map((c) => {
      const s = getComputedStyle(c);
      return {
        transition: s.transition,
        transform: s.transform,
        opacity: s.opacity,
      };
    }),
  };
});
console.log('step cards:', cardInfo.count);
console.log('card[0] computed:', JSON.stringify(cardInfo.transitions[0]));

// Now scroll down in small increments and sample card transforms to catch the entry animation
const samples = [];
for (let step = 0; step <= 30; step++) {
  const y = found.top - 950 + step * 45;
  await p.evaluate((yy) => window.scrollTo(0, yy), y);
  await p.waitForTimeout(70);
  const snap = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-hiwcard]')];
    return cards.map((c) => {
      const s = getComputedStyle(c);
      const r = c.getBoundingClientRect();
      return {
        o: +(+s.opacity).toFixed(2),
        tf: s.transform === 'none' ? '' : s.transform,
        top: Math.round(r.top),
      };
    });
  });
  samples.push({ step, scrollY: Math.round(y), cards: snap });
}
fs.writeFileSync(`${OUT}/entry-samples.json`, JSON.stringify(samples, null, 1));
// print compact: per step, card0 + card1 + card2 opacity & translateY
samples.forEach((s) => {
  const parts = s.cards.map((c, i) => {
    const m = c.tf.match(/matrix\([^)]*\)/);
    const ty = c.tf.match(/matrix\(1, 0, 0, 1, [^,]+, ([^)]+)\)/);
    return `c${i}:o${c.o}${c.tf ? ' tf=' + c.tf.slice(0, 34) : ''}`;
  });
  console.log(
    's' +
      String(s.step).padStart(2) +
      ' y' +
      s.scrollY +
      ': ' +
      parts.join(' | '),
  );
});
await b.close();
