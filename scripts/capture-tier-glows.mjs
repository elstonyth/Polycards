// Render the exact PokemonToken `landed` glow for all 6 price tiers and screenshot
// each + a combined grid. Self-contained (no server) — mirrors the real styling
// from src/app/slots/[slug]/PokemonToken.tsx + src/lib/price-tier.ts so the glow
// colors/spread match the live reel 1:1. Same sprite across all cells so the only
// visual difference IS the tier color.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

// Source of truth: src/lib/price-tier.ts
const TIERS = [
  {
    key: 'common',
    rgb: '156, 163, 175',
    hex: '#9ca3af',
    band: '< $25',
    zh: '灰 gray',
  },
  {
    key: 'uncommon',
    rgb: '125, 211, 252',
    hex: '#7dd3fc',
    band: '$25 – 99',
    zh: '浅蓝 light blue',
  },
  {
    key: 'rare',
    rgb: '37, 99, 235',
    hex: '#2563eb',
    band: '$100 – 499',
    zh: '深蓝 deep blue',
  },
  {
    key: 'mythical',
    rgb: '168, 85, 247',
    hex: '#a855f7',
    band: '$500 – 1,999',
    zh: '紫 purple',
  },
  {
    key: 'legendary',
    rgb: '244, 114, 182',
    hex: '#f472b6',
    band: '$2,000 – 9,999',
    zh: '亮粉 bright pink',
  },
  {
    key: 'immortal',
    rgb: '251, 146, 60',
    hex: '#fb923c',
    band: '≥ $10,000',
    zh: '橙 orange',
  },
];

// Charizard showdown gif (same sprite for every cell — isolates the color).
const DEX = 6;
const GIF = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/${DEX}.gif`;
const PNG = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${DEX}.png`;

const SIZE = 96; // --token-size, matches single-reel cellSize

const cell = (t) => `
  <div class="cell">
    <div class="token" style="box-shadow:0 0 18px 4px rgba(${t.rgb},0.85), 0 0 42px 10px rgba(${t.rgb},0.45)">
      <img src="${GIF}" onerror="this.onerror=null;this.src='${PNG}'" />
    </div>
    <div class="name" style="color:rgb(${t.rgb})">${t.key.toUpperCase()}</div>
    <div class="sub">${t.band}</div>
    <div class="sub hex">${t.hex} · ${t.zh}</div>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { background:#0a0a0a; font-family: ui-sans-serif, system-ui, sans-serif; padding: 48px; }
  h1 { color:#fafafa; font-size:22px; font-weight:800; letter-spacing:-0.02em; margin-bottom:6px; }
  p.cap { color:#a3a3a3; font-size:13px; margin-bottom:36px; }
  .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:36px 28px; }
  .cell { display:flex; flex-direction:column; align-items:center; justify-content:flex-start;
          padding:34px 12px 18px; background:#0a0a0a; border-radius:18px; }
  .token { width:${SIZE}px; height:${SIZE}px; border-radius:16px; display:flex; align-items:center;
           justify-content:center; transform:scale(1.1); margin-bottom:26px; }
  .token img { width:80%; height:80%; object-fit:contain; image-rendering:auto; }
  .name { font-size:14px; font-weight:800; letter-spacing:0.04em; }
  .sub { color:#d4d4d4; font-size:12px; margin-top:4px; font-variant-numeric:tabular-nums; }
  .sub.hex { color:#737373; font-size:11px; }
</style></head><body>
  <h1>Price-tier glow — reel winner cell (landed)</h1>
  <p class="cap">Same Pokémon every cell; only the glow color changes. Tier is by USD market value, not card rarity.</p>
  <div class="grid">${TIERS.map(cell).join('')}</div>
</body></html>`;

await mkdir('docs/research/tier-glows', { recursive: true });
const b = await chromium.launch();
try {
  const p = await b.newPage({
    viewport: { width: 980, height: 760 },
    deviceScaleFactor: 2,
  });
  await p.setContent(html, { waitUntil: 'load' });
  // Wait for every sprite to actually paint.
  await p
    .waitForFunction(
      () => [...document.images].every((i) => i.complete && i.naturalWidth > 0),
      null,
      { timeout: 30000 },
    )
    .catch(() => console.log('warn: some sprites may not have loaded'));
  await p.waitForTimeout(600);

  // Combined grid.
  await p.screenshot({ path: 'docs/research/tier-glows/all-tiers.png' });

  // Each cell individually.
  const cells = await p.locator('.cell').all();
  for (let i = 0; i < cells.length; i++) {
    await cells[i].screenshot({
      path: `docs/research/tier-glows/${TIERS[i].key}.png`,
    });
  }

  const broken = await p.evaluate(
    () =>
      [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
        .length,
  );
  console.log(
    'done. broken sprites:',
    broken,
    '| files: docs/research/tier-glows/{all-tiers,common,uncommon,rare,mythical,legendary,immortal}.png',
  );
} finally {
  await b.close();
}
