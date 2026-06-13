import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/howitworks/anim';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
// wait for content
for (let i = 0; i < 20; i++) {
  const ok = await page.evaluate(
    () => document.querySelectorAll('img').length > 5,
  );
  if (ok) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(3000);

// Find the Open Packs section and inspect ONE card's DOM + animation properties
const info = await page.evaluate(() => {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  // locate "Open Packs" heading then its section
  const h = [...document.querySelectorAll('h2,h3')].find(
    (e) => clean(e.textContent) === 'Open Packs',
  );
  if (!h) return { error: 'no Open Packs heading' };
  const section = h.closest('section') || h.parentElement.parentElement;
  // first card link
  const card = section.querySelector('a');
  if (!card) return { error: 'no card' };
  // walk the card, capture each element's tag/classes + animation/transition/transform-relevant computed styles
  function walk(el, d) {
    if (d > 5) return null;
    const cs = getComputedStyle(el);
    const interesting = {};
    [
      'animation',
      'animationName',
      'animationDuration',
      'transition',
      'transform',
      'transformStyle',
      'perspective',
      'transformOrigin',
      'willChange',
      'clipPath',
    ].forEach((p) => {
      const v = cs[p];
      if (
        v &&
        v !== 'none' &&
        v !== 'all 0s ease 0s' &&
        v !== 'normal' &&
        v !== '0s' &&
        v !== 'auto' &&
        v !== 'flat'
      )
        interesting[p] = v;
    });
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 80),
      isImg:
        el.tagName === 'IMG'
          ? (el.currentSrc || el.src || '')
              .replace(/^https?:\/\/[^/]+/, '')
              .split('?')[0]
          : undefined,
      styles: Object.keys(interesting).length ? interesting : undefined,
      children: [...el.children]
        .slice(0, 8)
        .map((c) => walk(c, d + 1))
        .filter(Boolean),
    };
  }
  // count imgs in one card
  const imgs = [...card.querySelectorAll('img')].map(
    (i) =>
      (i.currentSrc || i.src || '')
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0],
  );
  return {
    tree: walk(card, 0),
    imgsInCard: imgs,
    cardCount: section.querySelectorAll('a').length,
  };
});
fs.writeFileSync(`${OUT}/openpacks-dom.json`, JSON.stringify(info, null, 2));
console.log('imgsInCard:', JSON.stringify(info.imgsInCard));
console.log('cardCount:', info.cardCount);

// Capture the first card region over 3.5s to detect motion (hover + idle)
const h = await page.$('h2, h3');
// scroll Open Packs into view
await page.evaluate(() => {
  const hh = [...document.querySelectorAll('h2,h3')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  hh && hh.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(1000);
const firstCard = await page.$('section a, a:has(img)');
// idle frames
for (let f = 0; f < 6; f++) {
  await page.screenshot({
    path: `${OUT}/idle-${f}.png`,
    clip: { x: 0, y: 0, width: 1440, height: 700 },
  });
  await page.waitForTimeout(500);
}
// hover the first card and capture
try {
  const box = await page.evaluate(() => {
    const hh = [...document.querySelectorAll('h2,h3')].find(
      (e) => e.textContent.trim() === 'Open Packs',
    );
    const sec = hh.closest('section') || hh.parentElement.parentElement;
    const c = sec.querySelector('a');
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  for (let f = 0; f < 6; f++) {
    await page.screenshot({
      path: `${OUT}/hover-${f}.png`,
      clip: { x: 0, y: 0, width: 1440, height: 700 },
    });
    await page.waitForTimeout(400);
  }
} catch (e) {
  console.log('hover err', e.message);
}
console.log('FRAMES CAPTURED');
await browser.close();
