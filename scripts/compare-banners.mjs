// Recheck: stack each machine's ORIGINAL banner (lama-in, with phygitals) over the new
// rebranded banner (disk webp) so colour/position/size/residue can be judged side-by-side.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const BASES = [
  'mythic-pack',
  'legend-pack',
  'elite-pack',
  'platinum-pack',
  'rookie-pack',
  'trainer-pack',
  'starter-riftbound-pack',
  'black-pack-jjnfuk',
  'legend-pack-1dpaec',
  'modern-grails-noafw0',
  'pro-soccer-pack',
];
const CROP = 0.3; // top fraction (banner zone)
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1100, height: 1200 },
  deviceScaleFactor: 2,
});

for (const base of BASES) {
  const origB =
    'data:image/png;base64,' +
    (await readFile(`docs/research/packdetail/lama-in/${base}.png`)).toString(
      'base64',
    );
  const newB =
    'data:image/webp;base64,' +
    (await readFile(`public/images/claw/${base}-machine.webp`)).toString(
      'base64',
    );
  const html = `<!doctype html><body style="margin:0;background:#777;font:12px monospace;color:#fff">
    <div>ORIGINAL — ${base}</div>
    <div style="width:1000px;height:${Math.round(1000 * CROP * 0.69)}px;overflow:hidden;background:#444"><img src="${origB}" style="width:1000px;display:block"/></div>
    <div>REBRANDED</div>
    <div style="width:1000px;height:${Math.round(1000 * CROP * 0.69)}px;overflow:hidden;background:#444"><img src="${newB}" style="width:1000px;display:block"/></div>
  </body>`;
  const f = resolve(`docs/research/packdetail/_cmp_${base}.html`).replace(
    /\\/g,
    '/',
  );
  writeFileSync(f, html);
  await page.goto('file:///' + f, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/research/packdetail/cmp_${base}.png` });
  console.log(`${base} compared`);
}
await browser.close();
