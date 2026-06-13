// Render the ORIGINAL (phygitals) banner zone for riftbound + modern-grails so we can
// see exactly where the wordmark sat — to match Pokenic's position/extent, not guess.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const JOBS = [
  [
    'riftbound (orig avif)',
    'public/images/claw/starter-riftbound-pack-machine.avif',
  ],
  [
    'modern-grails (orig src.webp)',
    'public/images/claw/modern-grails-noafw0-machine-src.webp',
  ],
];
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1100, height: 700 },
  deviceScaleFactor: 1.6,
});
let i = 0;
for (const [label, p] of JOBS) {
  const buf = await readFile(p);
  const ext = p.endsWith('.avif') ? 'avif' : 'webp';
  const dataUrl = `data:image/${ext};base64,` + buf.toString('base64');
  await page.setContent(
    `<body style="margin:0;background:#222"><img id="m" src="${dataUrl}" style="width:1000px;display:block"/></body>`,
  );
  await page
    .waitForFunction(
      () => {
        const im = document.getElementById('m');
        return im && im.complete && im.naturalWidth > 0;
      },
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.waitForTimeout(300);
  const box = await page.locator('#m').boundingBox();
  await page.screenshot({
    path: `docs/research/packdetail/orig2_${i}.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height * 0.3 },
  });
  console.log(`${label} -> orig2_${i}.png`);
  i++;
}
await browser.close();
console.log('done');
