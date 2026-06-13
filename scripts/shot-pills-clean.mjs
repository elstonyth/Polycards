import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1000);
await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'How It Works',
  );
  h && h.scrollIntoView({ block: 'center' });
});
await p.waitForTimeout(1300);
// crop to the pills row (bottom of cards)
await p.screenshot({ path: 'docs/research/PILLS_home_clean.png' });
// inspect each pill's affordances precisely
const pills = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'How It Works',
  );
  const sec = h.closest('section');
  const pills = [...sec.querySelectorAll('a,div')].filter(
    (e) =>
      /View all packs|85-90% instant cash back|Ships worldwide/.test(
        e.textContent || '',
      ) &&
      (e.className || '').includes('rounded-xl') &&
      e.querySelector('svg,img'),
  );
  return pills.slice(0, 3).map((pl) => {
    const label = (
      pl.querySelector('.font-semibold')?.textContent ||
      pl.textContent ||
      ''
    )
      .trim()
      .slice(0, 30);
    const tag = pl.tagName;
    const imgs = pl.querySelectorAll('img').length;
    const svgs = [...pl.querySelectorAll('svg')]
      .map((s) => s.getAttribute('class') || '')
      .join(',');
    const isLink = tag === 'A';
    return { label, isLink, imgs, svgs };
  });
});
console.log(JSON.stringify(pills, null, 1));
await b.close();
