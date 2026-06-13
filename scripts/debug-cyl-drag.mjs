// Instrument the cylinder's pointer pipeline: which elements receive
// pointerdown/move/up at (720,450), and does the cylinder transform change?
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${BASE}/claw/pokemon-mythic`, {
  waitUntil: 'networkidle',
  timeout: 60000,
});
await page.getByRole('button', { name: /Try a free demo spin/i }).click();
await page.waitForTimeout(900);

await page.evaluate(() => {
  window.__log = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click']) {
    document.addEventListener(
      type,
      (e) => {
        if (window.__log.length > 80) return;
        const t = e.target;
        window.__log.push(
          `${type} -> ${t.tagName}.${('' + (t.className || '')).toString().slice(0, 40)} @${Math.round(e.clientX)},${Math.round(e.clientY)} buttons=${e.buttons}`,
        );
      },
      true,
    );
  }
  const cont = [...document.querySelectorAll('div')].find((d) =>
    ('' + d.className).includes('cursor-grab'),
  );
  window.__cont = cont;
  window.__hit = document.elementFromPoint(720, 450);
  window.__contRect = cont
    ? JSON.stringify(cont.getBoundingClientRect())
    : 'no container';
});
console.log('container rect:', await page.evaluate(() => window.__contRect));
console.log(
  'elementFromPoint(720,450):',
  await page.evaluate(() => {
    const e = window.__hit;
    return e ? `${e.tagName}.${('' + e.className).slice(0, 60)}` : 'none';
  }),
);

await page.mouse.move(720, 450);
await page.mouse.down();
await page.mouse.move(560, 450, { steps: 10 });
const dur = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find(
    (d) => getComputedStyle(d).transformStyle === 'preserve-3d',
  );
  return el
    ? el.style.transform || getComputedStyle(el).transform.slice(0, 60)
    : 'no cyl';
});
await page.mouse.up();
await page.waitForTimeout(900);
const after = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find(
    (d) => getComputedStyle(d).transformStyle === 'preserve-3d',
  );
  return el
    ? el.style.transform || getComputedStyle(el).transform.slice(0, 60)
    : 'no cyl';
});
console.log('transform during drag:', dur);
console.log('transform after release:', after);
console.log('--- event log ---');
console.log(
  (await page.evaluate(() => window.__log.join('\n'))).slice(0, 3000),
);
console.log('--- overlay text now ---');
console.log(
  await page.evaluate(() =>
    (
      document.body.innerText.match(
        /TAP TO [A-Z ]+|SHUFFLE|CATEGORY|Continue/gi,
      ) || []
    ).join(' | '),
  ),
);
await browser.close();
