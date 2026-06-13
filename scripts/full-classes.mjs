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
const out = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  const sec = h.closest('section') || h.parentElement.parentElement;
  const card = sec.querySelector('a');
  const dump = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className || '').toString(),
  });
  const all = [card, ...card.querySelectorAll('*')].map(dump);
  // also grab outerHTML of the image container (first inner div)
  const imgWrap = card.querySelector('div');
  return {
    all,
    imgWrapHTML: imgWrap ? imgWrap.outerHTML.slice(0, 1400) : null,
  };
});
console.log('=== ALL ELEMENT CLASSES ===');
out.all.forEach((e) => console.log(`  <${e.tag}> ${e.cls}`));
console.log('\n=== IMG WRAPPER HTML ===');
console.log(out.imgWrapHTML);
await browser.close();
