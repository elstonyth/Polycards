import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = 'docs/research/howitworks';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://www.phygitals.com/how-it-works', {
  waitUntil: 'networkidle',
  timeout: 60000,
});
await page.waitForTimeout(2500);

// Full-page screenshot
await page.screenshot({ path: `${OUT}/original-fullpage.png`, fullPage: true });

// Extract structure: section headings, paragraph text, images, buttons/links
const data = await page.evaluate(() => {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const headings = [...main.querySelectorAll('h1,h2,h3,h4')]
    .map((h) => ({ tag: h.tagName, text: clean(h.textContent) }))
    .filter((h) => h.text);
  const paragraphs = [...main.querySelectorAll('p')]
    .map((p) => clean(p.textContent))
    .filter((t) => t && t.length > 3)
    .slice(0, 60);
  const images = [...main.querySelectorAll('img')].map((im) => ({
    path: (im.currentSrc || im.src || '').replace(/^https?:\/\/[^/]+/, ''),
    alt: clean(im.alt),
    w: im.naturalWidth,
    h: im.naturalHeight,
  }));
  const buttons = [...main.querySelectorAll('a,button')]
    .map((b) => clean(b.textContent))
    .filter((t) => t && t.length < 40)
    .slice(0, 40);
  const scrollHeight = document.documentElement.scrollHeight;
  return {
    headings,
    paragraphs,
    images,
    buttons,
    scrollHeight,
    title: document.title,
  };
});

fs.writeFileSync(`${OUT}/structure.json`, JSON.stringify(data, null, 2));
console.log('RECON COMPLETE');
console.log('Title:', data.title);
console.log('ScrollHeight:', data.scrollHeight);
console.log('Headings:', JSON.stringify(data.headings, null, 1));
console.log(
  'Images:',
  data.images.length,
  '| paragraphs:',
  data.paragraphs.length,
);
await browser.close();
