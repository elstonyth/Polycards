// Faithful static render of the updated OddsSheet (rarity odds + NEW glow-tier
// legend) so the new layout can be eyeballed without booting the full app.
// Markup/classes mirror src/app/slots/[slug]/OddsSheet.tsx; values are the real
// ODDS (packs-data.ts) + TIER_COLOR/TIER_BAND (price-tier.ts).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const ODDS = [
  { rarity: 'Legendary', chance: '0.5%', dot: '#fbbf24' },
  { rarity: 'Epic', chance: '4.5%', dot: '#e879f9' },
  { rarity: 'Rare', chance: '15%', dot: '#38bdf8' },
  { rarity: 'Uncommon', chance: '30%', dot: '#34d399' },
  { rarity: 'Common', chance: '50%', dot: '#a3a3a3' },
];
const TIERS = [
  { name: 'common', rgb: '156, 163, 175', band: '< $25' },
  { name: 'uncommon', rgb: '125, 211, 252', band: '$25 – 99' },
  { name: 'rare', rgb: '37, 99, 235', band: '$100 – 499' },
  { name: 'mythical', rgb: '168, 85, 247', band: '$500 – 1,999' },
  { name: 'legendary', rgb: '244, 114, 182', band: '$2,000 – 9,999' },
  { name: 'immortal', rgb: '251, 146, 60', band: '≥ $10,000' },
];

const row = (label, right, dotStyle, cap = false) => `
  <li class="li">
    <span class="left${cap ? ' cap' : ''}"><span class="dot" style="${dotStyle}"></span>${label}</span>
    <span class="right">${right}</span>
  </li>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing:border-box; margin:0; }
  body { background:#000; display:flex; justify-content:center; padding:28px;
         font-family: ui-sans-serif, system-ui, sans-serif; }
  .card { width:384px; border:1px solid rgba(255,255,255,.10); background:#171717;
          border-radius:16px; padding:20px; }
  .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  h2 { color:#fff; font-size:18px; font-weight:800; letter-spacing:-0.02em; }
  h3 { color:#fff; font-size:14px; font-weight:800; letter-spacing:-0.02em; margin:20px 0 8px; }
  h3 .mut { color:rgba(255,255,255,.4); }
  .x { color:rgba(255,255,255,.6); font-size:18px; }
  ul { list-style:none; overflow:hidden; border-radius:12px;
       border:1px solid rgba(255,255,255,.10); background:rgba(255,255,255,.03); }
  .li { display:flex; align-items:center; justify-content:space-between;
        border-bottom:1px solid rgba(255,255,255,.05); padding:12px 16px; }
  .li:last-child { border-bottom:none; }
  .left { display:flex; align-items:center; gap:10px; color:#fff; font-size:13px; font-weight:500; }
  .left.cap { text-transform:capitalize; }
  .dot { width:10px; height:10px; border-radius:9999px; }
  .right { color:rgba(255,255,255,.55); font-size:13px; font-variant-numeric:tabular-nums; }
  .note { color:rgba(255,255,255,.35); font-size:11px; margin:8px 0 0 4px; }
</style></head><body>
  <div class="card">
    <div class="head"><h2>Pull odds by rarity</h2><span class="x">✕</span></div>
    <ul>${ODDS.map((o) => row(o.rarity, o.chance, `background:${o.dot}`)).join('')}</ul>
    <p class="note">Indicative odds — final rates are published by the backend.</p>
    <h3>Glow tiers <span class="mut">· by card value</span></h3>
    <ul>${TIERS.map((t) => row(t.name, t.band, `background:rgb(${t.rgb});box-shadow:0 0 6px 1px rgba(${t.rgb},.7)`, true)).join('')}</ul>
  </div>
</body></html>`;

await mkdir('docs/research/tier-glows', { recursive: true });
const b = await chromium.launch();
try {
  const p = await b.newPage({
    viewport: { width: 440, height: 720 },
    deviceScaleFactor: 2,
  });
  await p.setContent(html, { waitUntil: 'load' });
  await p.waitForTimeout(300);
  await p
    .locator('.card')
    .screenshot({ path: 'docs/research/tier-glows/odds-sheet-updated.png' });
  console.log('done → docs/research/tier-glows/odds-sheet-updated.png');
} finally {
  await b.close();
}
