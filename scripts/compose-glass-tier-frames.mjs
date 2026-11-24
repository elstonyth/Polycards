// Cut the Blender glass renders (scripts/render-glass-tier-frames.py) to the
// exact band shapes SlabImage places, write the SHIPPED tier frames
// (public/images/slab-frames + raw-frames/<tier>.webp), and build a preview
// sheet at real display sizes with the storefront's halo on.
//
// Geometry is 1:1 with src/components/SlabImage.tsx. A tier with no render in
// the input folder is skipped, so one tier can be checked before the rest.
//
// usage: node scripts/compose-glass-tier-frames.mjs [--no-ship] [--only <frame>]
//   --no-ship  build only the preview sheet, leave public/ alone
//   --only     one frame (e.g. lucky-draw): the rest of public/ is not rewritten,
//              and the sheet goes to glass-frames-sheet-<frame>.png
import { existsSync } from 'node:fs';
import sharp from 'sharp';

const IN = 'docs/research/glass-frames';
const SHIP = !process.argv.includes('--no-ship');
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const SHEET = `docs/research/glass-frames-sheet${ONLY ? `-${ONLY}` : ''}.png`;

// src/lib/rarity.ts RARITY_RGB, keyed by the frame filename.
const TIERS = {
  immortal: [251, 146, 60],
  legendary: [236, 72, 153],
  mythical: [168, 85, 247],
  rare: [37, 99, 235],
  uncommon: [56, 189, 248],
  common: [163, 163, 163],
  // Not a tier: the Lucky Draw prize frame, rendered by the same script
  // (--frame lucky-draw). Its halo is SlabImage's VARIANT_RGB.
  'lucky-draw': [216, 200, 255],
};

// Band boxes in px: outer size, outer radius, band width, hole radius.
const KINDS = {
  slab: { w: 1600, h: 2590, outerR: 147, inset: 79, holeR: 55 },
  raw: { w: 1240, h: 1685, outerR: 117, inset: 64, holeR: 53 },
};

const rr = (x, y, w, h, r) => {
  const x1 = x + w;
  const y1 = y + h;
  return (
    `M${x + r},${y}H${x1 - r}A${r},${r} 0 0 1 ${x1},${y + r}V${y1 - r}` +
    `A${r},${r} 0 0 1 ${x1 - r},${y1}H${x + r}A${r},${r} 0 0 1 ${x},${y1 - r}` +
    `V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`
  );
};

const svg = (w, h, body) =>
  Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' width='${w}' height='${h}'>${body}</svg>`,
  );

const bandMask = ({ w, h, outerR, inset, holeR }) =>
  sharp(
    svg(
      w,
      h,
      `<path fill='white' fill-rule='evenodd' d='${rr(0, 0, w, h, outerR)} ${rr(inset, inset, w - 2 * inset, h - 2 * inset, holeR)}'/>`,
    ),
  )
    .png()
    .toBuffer();

/** The render, cut to the band: opaque glass, clean hole, nothing outside. */
async function cutBand(kind, name) {
  const g = KINDS[kind];
  return sharp(`${IN}/${name}.png`)
    .resize(g.w, g.h, { fit: 'fill' })
    .ensureAlpha()
    .composite([{ input: await bandMask(g), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/** One preview tile: page colour, the storefront halo, the band, its filling. */
async function tile(kind, tier, band, width) {
  const g = KINDS[kind];
  const s = width / g.w;
  const pad = 70; // room for the halo
  const bw = Math.round(g.w * s);
  const bh = Math.round(g.h * s);
  const rgb = TIERS[tier].join(',');
  // SlabImage glowShadow: 0 0 44px -2px rgba(.8), 0 0 90px -20px rgba(.6).
  const halo = (blur, spread, alpha) =>
    `<rect x='${pad - spread}' y='${pad - spread}' width='${bw + 2 * spread}' height='${bh + 2 * spread}' rx='${g.outerR * s}' fill='rgba(${rgb},${alpha})' filter='url(#b${blur})'/>`;
  const base = svg(
    bw + 2 * pad,
    bh + 2 * pad,
    `<defs><filter id='b44' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='22'/></filter>` +
      `<filter id='b90' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='45'/></filter></defs>` +
      `<rect width='100%' height='100%' fill='#171717'/>${halo(44, -2, 0.8)}${halo(90, -20, 0.6)}` +
      // What the band wraps: the slab case, or a card.
      `<path d='${rr(pad + g.inset * s, pad + g.inset * s, bw - 2 * g.inset * s, bh - 2 * g.inset * s, g.holeR * s)}' fill='${kind === 'slab' ? '#0e0e10' : '#2b2b2e'}'/>`,
  );
  const layers = [
    {
      input: await sharp(band).resize(bw, bh).png().toBuffer(),
      left: pad,
      top: pad,
    },
  ];
  if (kind === 'slab') {
    // The slab sits 5% inside the 1600x2700 box; the band box is 55px shorter
    // top and bottom, so in band coordinates the slab starts at (80, 80).
    layers.unshift({
      input: await sharp('public/images/slab-frame.webp')
        .resize(Math.round(1440 * s), Math.round(2430 * s))
        .png()
        .toBuffer(),
      left: pad + Math.round(80 * s),
      top: pad + Math.round(80 * s),
    });
  }
  return sharp(base).composite(layers).png().toBuffer();
}

// '' is the still frame; '-lit' is the state a big slab's travelling light
// reveals (SlabImage `animated`), so it is only previewed at hero size.
const VARIANTS = ['', '-lit'];
const rows = [];
for (const kind of Object.keys(KINDS)) {
  for (const variant of VARIANTS) {
    const tiles = { hero: [], grid: [] };
    for (const tier of Object.keys(TIERS)) {
      const name = `${kind}-${tier}${variant}`;
      if (ONLY && tier !== ONLY) continue;
      if (!existsSync(`${IN}/${name}.png`)) continue;
      const band = await cutBand(kind, name);
      if (SHIP) {
        await sharp(band)
          .webp({ quality: 90, alphaQuality: 100 })
          .toFile(`public/images/${kind}-frames/${tier}${variant}.webp`);
      }
      const hero = kind === 'slab' ? 420 : 320;
      tiles.hero.push(await tile(kind, tier, band, hero));
      if (!variant) tiles.grid.push(await tile(kind, tier, band, hero * 0.38));
    }
    for (const set of Object.values(tiles)) if (set.length) rows.push(set);
  }
}

// Stack the rows into one sheet.
const sized = await Promise.all(
  rows.map(async (set) => {
    const meta = await Promise.all(set.map((t) => sharp(t).metadata()));
    return {
      set,
      meta,
      w: meta.reduce((a, m) => a + m.width, 0),
      h: meta[0].height,
    };
  }),
);
if (!sized.length) throw new Error(`no renders found in ${IN}`);
const layers = [];
let y = 0;
for (const row of sized) {
  let x = 0;
  row.set.forEach((input, i) => {
    layers.push({ input, left: x, top: y });
    x += row.meta[i].width;
  });
  y += row.h;
}
await sharp({
  create: {
    width: Math.max(...sized.map((r) => r.w)),
    height: y,
    channels: 4,
    background: '#171717',
  },
})
  .composite(layers)
  .png()
  .toFile(SHEET);
console.log(
  `done: ${SHEET}${SHIP ? ' + public/images/{slab,raw}-frames/<tier>.webp' : ''}`,
);
