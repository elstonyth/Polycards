// High-zoom look at the baked mythic banner to see if the rectangle reconstruction
// left a visible box/seam (vs the live overlay the user may be seeing cached).
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

// mythic 1440x1000 — banner reconstruction region ~ x28-66%, y12-25%
const html = `<!doctype html><body style="margin:0;background:#000">
  <div style="width:1600px;height:520px;overflow:hidden;position:relative">
    <img src="../../../public/images/claw/mythic-pack-machine.webp"
         style="position:absolute;width:4000px;left:-1010px;top:-430px"/>
  </div>
</body>`;
writeFileSync('docs/research/packdetail/zoom.html', html);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 520 },
  deviceScaleFactor: 2,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/zoom.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1000);
await page.screenshot({ path: 'docs/research/packdetail/zoom-mythic.png' });
await browser.close();
console.log('zoomed');
