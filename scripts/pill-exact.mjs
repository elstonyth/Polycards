import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
const out = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'How It Works',
  );
  const sec = h.closest('section');
  // the actual pills have class mt-auto + rounded-xl (from StepInfoPill base)
  const pills = [...sec.querySelectorAll('.mt-auto.rounded-xl')];
  return pills.map((pl) => {
    const label = (
      pl.querySelector('.font-semibold')?.textContent || ''
    ).trim();
    const svgClasses = [...pl.querySelectorAll(':scope svg')]
      .map((s) => (s.getAttribute('class') || '').replace('lucide lucide-', ''))
      .join(' + ');
    const imgCount = pl.querySelectorAll(':scope img').length;
    return { label, tag: pl.tagName, imgCount, svgs: svgClasses };
  });
});
console.log(JSON.stringify(out, null, 1));
await b.close();
