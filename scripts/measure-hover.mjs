import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 20; i++) {
  if (await page.evaluate(() => document.querySelectorAll('img').length > 5))
    break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  h && h.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(800);

const measure = () =>
  page.evaluate(() => {
    const h = [...document.querySelectorAll('h2,h3')].find(
      (e) => e.textContent.trim() === 'Open Packs',
    );
    const sec = h.closest('section') || h.parentElement.parentElement;
    const card = sec.querySelector('a');
    const imgs = [...card.querySelectorAll('img')];
    return imgs.map((im) => {
      const cs = getComputedStyle(im);
      const r = im.getBoundingClientRect();
      return {
        src: (im.currentSrc || im.src)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
          .split('/')
          .pop(),
        cls: (im.className || '').toString(),
        transform: cs.transform,
        opacity: cs.opacity,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
      };
    });
  });

const idle = await measure();
// hover
const box = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  const sec = h.closest('section') || h.parentElement.parentElement;
  const c = sec.querySelector('a');
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(900);
const hover = await measure();

console.log('=== IDLE ===');
console.log(JSON.stringify(idle, null, 1));
console.log('=== HOVER ===');
console.log(JSON.stringify(hover, null, 1));
await browser.close();
