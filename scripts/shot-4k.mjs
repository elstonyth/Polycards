import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [url, name] of [
  ['http://localhost:4000/', 'HOME'],
  ['http://localhost:4000/how-it-works', 'HIW'],
]) {
  const p = await b.newPage({ viewport: { width: 3840, height: 2160 } });
  await p.goto(url, { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: `docs/research/4K_${name}_top.png`,
    clip: { x: 0, y: 0, width: 3840, height: 1400 },
  });
  // scroll to how it works on home / steps on hiw
  await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((e) =>
      /how it works/i.test(e.textContent),
    );
    h && h.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(1200);
  await p.screenshot({
    path: `docs/research/4K_${name}_hiw.png`,
    clip: { x: 0, y: 0, width: 3840, height: 2000 },
  });
  await p.close();
}
await b.close();
console.log('4k shots done');
