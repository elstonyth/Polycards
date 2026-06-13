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
const res = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  const sec = h.closest('section') || h.parentElement.parentElement;
  const card = sec.querySelector('a');
  const slab = card.querySelectorAll('img')[0],
    pack = card.querySelectorAll('img')[1];
  const g = (el) => {
    const cs = getComputedStyle(el);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationIterationCount: cs.animationIterationCount,
      transition: cs.transition,
      transform: cs.transform,
    };
  };
  // also check the card's parent scroll row for marquee animation
  const row = card.parentElement;
  return {
    card: g(card),
    slab: g(slab),
    pack: g(pack),
    row: { ...g(row), cls: (row.className || '').toString() },
  };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
