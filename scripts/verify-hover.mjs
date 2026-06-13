import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);

// --- Bug 1: Open Packs card image lift ---
await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  h && h.scrollIntoView({ block: 'center' });
});
await p.waitForTimeout(600);
const op = await p.evaluate(async () => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  const sec = h.closest('section');
  const card = sec.querySelector('a');
  const slab = card.querySelector('img');
  const before = slab.getBoundingClientRect().top;
  // dispatch real hover
  card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  return { before, cls: slab.className.includes('group-hover:-translate-y-2') };
});
// use Playwright's real hover (drives :hover state)
const cardBox = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  const c = h.closest('section').querySelector('a');
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await p.mouse.move(cardBox.x, cardBox.y);
await p.waitForTimeout(500);
const opAfter = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  const slab = h.closest('section').querySelector('a img');
  return slab.getBoundingClientRect().top;
});
console.log(
  'BUG1 Open Packs: before.top=' +
    Math.round(op.before) +
    ' hover.top=' +
    Math.round(opAfter) +
    ' delta=' +
    Math.round(opAfter - op.before) +
    'px (expect ~ -8)',
);

// --- Bug 2: CTA fan image lift ---
await p.mouse.move(10, 10);
await p.waitForTimeout(300);
await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((e) =>
    e.textContent.includes('Ready to start'),
  );
  h && h.scrollIntoView({ block: 'center' });
});
await p.waitForTimeout(600);
const ctaBefore = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((e) =>
    e.textContent.includes('Ready to start'),
  );
  const a = h.closest('a');
  const img = a.querySelectorAll('img')[0];
  return img.getBoundingClientRect().top;
});
const ctaBox = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((e) =>
    e.textContent.includes('Ready to start'),
  );
  const r = h.closest('a').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height - 60 };
});
await p.mouse.move(ctaBox.x, ctaBox.y);
await p.waitForTimeout(700);
const ctaAfter = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((e) =>
    e.textContent.includes('Ready to start'),
  );
  const img = h.closest('a').querySelectorAll('img')[0];
  return img.getBoundingClientRect().top;
});
console.log(
  'BUG2 CTA fan: before.top=' +
    Math.round(ctaBefore) +
    ' hover.top=' +
    Math.round(ctaAfter) +
    ' delta=' +
    Math.round(ctaAfter - ctaBefore) +
    'px (expect ~ -8)',
);

const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken images:', broken);
await b.close();
