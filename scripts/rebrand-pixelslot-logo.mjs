// Renders the PixelSlot header wordmark in the SAME treatment as the original
// POKÉNIC logo (yellow fill + thick blue outline + drop shadow + slight tilt),
// via Playwright so Google Fonts load. Reuses the render pattern from the other
// rebrand-*.mjs scripts (font @import + screenshot).
//
// Modes:
//   node scripts/rebrand-pixelslot-logo.mjs candidates   -> dark-bg comparison sheet of font options (for picking)
//   node scripts/rebrand-pixelslot-logo.mjs final <font>  -> transparent PixelSlot logo PNG (default font: "Luckiest Guy")
//   node scripts/rebrand-pixelslot-logo.mjs icon <font>   -> circular badge base + resized favicon/app/seo icons
//   node scripts/rebrand-pixelslot-logo.mjs og <font>     -> 1200x630 OG/Twitter share banner
//
// Output: docs/research/pixelslot-logo-candidates.png | public/branding/pixelslot-logo.png
//         public/branding/pixelslot-icon.png + public/seo/icon-{192,512}.png + src/app/{icon,apple-icon}.png
//         public/seo/og.png
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const mode = process.argv[2] || 'candidates';
const chosenFont = process.argv[3] || 'Luckiest Guy';

// Brand colours sampled from the original POKÉNIC wordmark.
const YELLOW = '#FFCB05';
const BLUE = '#2A5CAA';
const SHADOW = '#173a7a';

// Candidate chunky/playful display faces that echo the Pokémon-solid feel.
const CANDIDATES = ['Luckiest Guy', 'Titan One', 'Fredoka', 'Baloo 2'];
const WEIGHT = {
  'Luckiest Guy': 400,
  'Titan One': 400,
  Fredoka: 700,
  'Baloo 2': 800,
};

// The exact treatment: yellow fill, thick blue stroke (paint-order so fill sits
// on top), layered drop shadow, tiny CCW tilt like the original.
function wordCss(font, size) {
  return `
    font-family: '${font}', cursive, sans-serif;
    font-weight: ${WEIGHT[font] ?? 700};
    font-size: ${size}px;
    color: ${YELLOW};
    -webkit-text-stroke: ${Math.round(size * 0.055)}px ${BLUE};
    paint-order: stroke fill;
    text-shadow: 0 ${Math.round(size * 0.06)}px 0 ${SHADOW}, 0 ${Math.round(size * 0.08)}px 10px rgba(0,0,0,.4);
    letter-spacing: ${Math.round(size * 0.01)}px;
    line-height: 1;
    transform: rotate(-2.5deg);
    white-space: nowrap;`;
}

const fontImport =
  "@import url('https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Titan+One&family=Fredoka:wght@700&family=Baloo+2:wght@800&display=swap');";

const browser = await chromium.launch();
// try/finally so an error mid-render never orphans the chromium process.
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });

  if (mode === 'candidates') {
    const rows = CANDIDATES.map(
      (f) => `
      <div class="row">
        <div class="label">${f}</div>
        <div class="word" style="${wordCss(f, 96)}">PixelSlot</div>
      </div>`,
    ).join('');
    await page.setContent(`<!doctype html><html><head><style>
    ${fontImport}
    * { margin:0; box-sizing:border-box; }
    body { background:#171717; padding:56px 72px; width:1180px; }
    .row { display:flex; align-items:center; gap:40px; padding:34px 0; border-bottom:1px solid #2a2a2a; }
    .row:last-child { border-bottom:0; }
    .label { color:#8a8a8a; font-family:system-ui,sans-serif; font-size:15px; width:150px; letter-spacing:.06em; text-transform:uppercase; }
    .word { padding:12px 6px; }
  </style></head><body>${rows}</body></html>`);
    // give the webfonts a beat to load
    await page.evaluate(() => document.fonts.ready);
    const out = resolve(ROOT, 'docs/research/pixelslot-logo-candidates.png');
    const el = await page.$('body');
    await el.screenshot({ path: out });
    console.log('wrote', out);
  } else if (mode === 'icon') {
    const S = 1024;
    await page.setViewportSize({ width: S, height: S });
    await page.setContent(`<!doctype html><html><head><style>
    ${fontImport}
    * { margin:0; box-sizing:border-box; }
    html,body { background:transparent; }
    #badge { width:${S}px; height:${S}px; border-radius:50%; background:${BLUE};
      display:flex; align-items:center; justify-content:center; }
    .inner { width:88%; height:88%; border-radius:50%;
      background:radial-gradient(circle at 50% 42%, #ffffff 0%, #e4eefb 55%, #c6dbf6 100%);
      display:flex; flex-direction:column; align-items:center; justify-content:center; }
    .word { ${wordCss(chosenFont, Math.round(S * 0.125))} }
    .tag { font-family:Arial,system-ui,sans-serif; font-weight:800; color:${BLUE};
      font-size:${Math.round(S * 0.048)}px; letter-spacing:.05em; margin-top:${Math.round(S * 0.015)}px; }
  </style></head><body>
    <div id="badge"><div class="inner">
      <div class="word">PixelSlot</div>
      <div class="tag">PIXELSLOT.OFFICIAL</div>
    </div></div>
  </body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const base = resolve(ROOT, 'public/branding/pixelslot-icon.png');
    await (
      await page.$('#badge')
    ).screenshot({ path: base, omitBackground: true });
    const targets = [
      ['public/seo/icon-512x512.png', 512],
      ['public/seo/icon-192x192.png', 192],
      ['src/app/apple-icon.png', 180],
      ['src/app/icon.png', 512],
    ];
    for (const [p, sz] of targets) {
      await sharp(base).resize(sz, sz).png().toFile(resolve(ROOT, p));
      console.log('wrote', p, `${sz}x${sz}`);
    }
    console.log('wrote', base);
  } else if (mode === 'og') {
    const W = 1200;
    const H = 630;
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(`<!doctype html><html><head><style>
    ${fontImport}
    * { margin:0; box-sizing:border-box; }
    body { width:${W}px; height:${H}px; overflow:hidden;
      background:radial-gradient(circle at 50% 40%, #1e1e1e 0%, #141414 55%, #0d0d0d 100%);
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:34px; }
    .glow { position:absolute; left:50%; top:40%; transform:translate(-50%,-50%);
      width:840px; height:340px; background:radial-gradient(ellipse, rgba(42,92,170,.4), transparent 70%); filter:blur(40px); }
    .word { ${wordCss(chosenFont, 168)} position:relative; }
    .tag { position:relative; font-family:Arial,system-ui,sans-serif; font-weight:700; color:#e9e9e9;
      font-size:33px; letter-spacing:.02em; }
  </style></head><body>
    <div class="glow"></div>
    <div class="word">PixelSlot</div>
    <div class="tag">Rip packs · Pull graded cards · Sell back up to 90%</div>
  </body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const out = resolve(ROOT, 'public/seo/og.png');
    await page.screenshot({
      path: out,
      clip: { x: 0, y: 0, width: W, height: H },
    });
    console.log('wrote', out);
  } else {
    const size = 200;
    await page.setContent(`<!doctype html><html><head><style>
    ${fontImport}
    * { margin:0; box-sizing:border-box; }
    html,body { background:transparent; }
    #stage { display:inline-block; padding:${Math.round(size * 0.5)}px ${Math.round(size * 0.55)}px; }
    .word { ${wordCss(chosenFont, size)} }
  </style></head><body><div id="stage"><span class="word">PixelSlot</span></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const out = resolve(ROOT, 'public/branding/pixelslot-logo.png');
    const el = await page.$('#stage');
    await el.screenshot({ path: out, omitBackground: true });
    console.log('wrote', out, 'font:', chosenFont);
  }
} finally {
  await browser.close();
}
