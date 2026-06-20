// Faithful preview of the admin pack-odds Rarity dropdown AFTER adding Immortal.
// The real options are RARITIES from @acme/odds-math (now 6, Immortal first);
// styling mirrors the @medusajs/ui dark Select in the operator screenshot.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

// As rendered: trigger shows the current value; the open panel lists RARITIES
// with a check on the selected row. Example pack-odds row selected = 'Epic'.
const OPTIONS = ['Immortal', 'Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const SELECTED = 'Epic';

const item = (o) => `
  <div class="item${o === SELECTED ? ' sel' : ''}">
    <span class="check">${o === SELECTED ? '✓' : ''}</span>
    <span>${o}</span>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing:border-box; margin:0; }
  body { background:#161616; font-family: Inter, ui-sans-serif, system-ui, sans-serif;
         padding:28px; display:flex; }
  .wrap { display:flex; flex-direction:column; gap:0; }
  .trigger { width:230px; display:flex; align-items:center; justify-content:space-between;
             background:#1f1f1f; border:1px solid #3a82f6; border-radius:8px;
             padding:9px 12px; color:#ededed; font-size:13px; }
  .chev { color:#8a8a8a; font-size:11px; line-height:1; }
  .panel { width:230px; margin-top:6px; background:#1c1c1c; border:1px solid #2e2e2e;
           border-radius:10px; padding:6px; box-shadow:0 12px 30px rgba(0,0,0,.55); }
  .item { display:flex; align-items:center; gap:8px; padding:8px 8px 8px 6px;
          border-radius:6px; color:#ededed; font-size:13px; }
  .item.sel { background:#242424; }
  .item:not(.sel):hover { background:#222; }
  .check { width:14px; display:inline-flex; justify-content:center; color:#ededed; font-size:12px; }
  .badge { margin-top:14px; color:#fb923c; font-size:11px; font-weight:600; }
</style></head><body>
  <div class="wrap">
    <div class="trigger"><span>${SELECTED}</span><span class="chev">▲▼</span></div>
    <div class="panel">${OPTIONS.map(item).join('')}</div>
    <div class="badge">▲ NEW: Immortal (apex tier)</div>
  </div>
</body></html>`;

await mkdir('docs/research/tier-glows', { recursive: true });
const b = await chromium.launch();
try {
  const p = await b.newPage({
    viewport: { width: 300, height: 360 },
    deviceScaleFactor: 2,
  });
  await p.setContent(html, { waitUntil: 'load' });
  await p.waitForTimeout(250);
  await p
    .locator('.wrap')
    .screenshot({ path: 'docs/research/tier-glows/admin-rarity-dropdown.png' });
  console.log('done → docs/research/tier-glows/admin-rarity-dropdown.png');
} finally {
  await b.close();
}
