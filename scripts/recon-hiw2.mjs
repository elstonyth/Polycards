import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/howitworks';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://www.phygitals.com/how-it-works', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
// wait until real content shows up (images or several paragraphs), polling up to 20s
for (let i = 0; i < 20; i++) {
  const ok = await page.evaluate(() => {
    const m = document.querySelector('main') || document.body;
    return (
      m.querySelectorAll('img').length > 0 || m.querySelectorAll('p').length > 2
    );
  });
  if (ok) break;
  await page.waitForTimeout(1000);
}
// scroll through to trigger lazy content
for (let y = 0; y < 2400; y += 400) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(400);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/original-fullpage.png`, fullPage: true });
const data = await page.evaluate(() => {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const m = document.querySelector('main') || document.body;
  return {
    headings: [...m.querySelectorAll('h1,h2,h3,h4')]
      .map((h) => ({ tag: h.tagName, text: clean(h.textContent) }))
      .filter((h) => h.text),
    paragraphs: [...m.querySelectorAll('p')]
      .map((p) => clean(p.textContent))
      .filter((t) => t && t.length > 3)
      .slice(0, 80),
    images: [...m.querySelectorAll('img')].map((im) => ({
      path: (im.currentSrc || im.src || '').replace(/^https?:\/\/[^/]+/, ''),
      alt: clean(im.alt),
    })),
    buttons: [...m.querySelectorAll('a,button')]
      .map((b) => clean(b.textContent))
      .filter((t) => t && t.length < 40)
      .slice(0, 40),
    scrollHeight: document.documentElement.scrollHeight,
  };
});
fs.writeFileSync(`${OUT}/structure.json`, JSON.stringify(data, null, 2));
console.log(
  'DONE imgs=' +
    data.images.length +
    ' paras=' +
    data.paragraphs.length +
    ' headings=' +
    data.headings.length,
);
await browser.close();
