// Build the SHIPPED raw-card tier frames — the "glass border" candidate picked
// from scripts/compose-rawframe-variants.mjs, hue-tinted per gacha rarity
// (colors = RARITY_RGB in src/lib/rarity.ts) plus the prism cosmetic variant
// (spectral, mirrors public/images/slab-frames/prism.webp).
//
// Geometry (measured — see compose-rawframe-variants.mjs header): on the
// 1600×2700 SLAB_ASPECT box the card is 1112×1557 at (244, 572), radius 53;
// the band pads it by 64px, outer radius 117. Assets are CROPPED to the band's
// bounding box (1240×1685 at (180, 508)) — SlabImage places them by inset, the
// same trick the slab tier band uses — and written to
// public/images/raw-frames/<tier>.webp.
//
// usage: node scripts/compose-rawframe-tiers.mjs
import sharp from 'sharp';

const CARD_W = 1112;
const CARD_H = 1557;
const CARD_R = 53;
const PAD = 64;
const BAND_W = CARD_W + 2 * PAD; // 1240
const BAND_H = CARD_H + 2 * PAD; // 1685
const OUTER_R = CARD_R + PAD; // 117

// src/lib/rarity.ts RARITY_RGB, keyed by the frameSrc filename.
const TIERS = {
  immortal: [251, 146, 60],
  legendary: [236, 72, 153],
  mythical: [168, 85, 247],
  rare: [37, 99, 235],
  uncommon: [56, 189, 248],
  common: [163, 163, 163],
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

// The dark-glass band on its own canvas: outer rect minus the card window.
const ringPath = `${rr(0, 0, BAND_W, BAND_H, OUTER_R)} ${rr(PAD, PAD, CARD_W, CARD_H, CARD_R)}`;
const ring = `<path fill-rule='evenodd' d='${ringPath}'`;
const innerEdge = rr(PAD - 2, PAD - 2, CARD_W + 4, CARD_H + 4, CARD_R + 2);

// Tint recipe: the approved neutral glass gradient with the tier hue mixed in
// at low strength (glass stays dark; hue reads in the sheen + the hairlines).
const mix = ([r, g, b], base, k) => {
  const m = (c, bc) => Math.round(bc + (c - bc) * k);
  return `rgb(${m(r, base)},${m(g, base)},${m(b, base)})`;
};

const bandSvg = (rgb) =>
  Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${BAND_W} ${BAND_H}' width='${BAND_W}' height='${BAND_H}'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
        <stop offset='0' stop-color='${mix(rgb, 46, 0.22)}'/>
        <stop offset='.5' stop-color='${mix(rgb, 27, 0.12)}'/>
        <stop offset='1' stop-color='${mix(rgb, 38, 0.18)}'/>
      </linearGradient></defs>
      ${ring} fill='url(#g)' opacity='0.96'/>
      ${ring} fill='none' stroke='rgba(${rgb.join(',')},0.35)' stroke-width='3'/>
      <path d='${innerEdge}' fill='none' stroke='rgba(${rgb.join(',')},0.55)' stroke-width='3'/>
    </svg>`,
  );

// Prism: spectral sweep instead of a tier hue (white glow at runtime).
const prismSvg = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${BAND_W} ${BAND_H}' width='${BAND_W}' height='${BAND_H}'>
    <defs><linearGradient id='p' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='#5a2e3a'/><stop offset='.2' stop-color='#5a4a2e'/>
      <stop offset='.4' stop-color='#2e5a3a'/><stop offset='.6' stop-color='#2e4a5a'/>
      <stop offset='.8' stop-color='#3a2e5a'/><stop offset='1' stop-color='#5a2e52'/>
    </linearGradient></defs>
    ${ring} fill='url(#p)' opacity='0.96'/>
    ${ring} fill='none' stroke='rgba(255,255,255,0.30)' stroke-width='3'/>
    <path d='${innerEdge}' fill='none' stroke='rgba(255,255,255,0.5)' stroke-width='3'/>
  </svg>`,
);

const outDir = 'public/images/raw-frames';
await sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .webp()
  .toBuffer(); // warm sharp before the loop (first-call cost)

import { mkdirSync } from 'node:fs';
mkdirSync(outDir, { recursive: true });

for (const [tier, rgb] of Object.entries(TIERS)) {
  await sharp(bandSvg(rgb))
    .webp({ quality: 90 })
    .toFile(`${outDir}/${tier}.webp`);
}
await sharp(prismSvg).webp({ quality: 90 }).toFile(`${outDir}/prism.webp`);

// Preview strip: every tier band around the sample raw card on the tile bg.
const CARD_SRC =
  'backend/packages/api/static/1784167279907-pc-fsbqea5aod5mejp5-1600.webp';
const cardMask = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${CARD_W} ${CARD_H}' width='${CARD_W}' height='${CARD_H}'><path fill='white' d='${rr(0, 0, CARD_W, CARD_H, CARD_R)}'/></svg>`,
);
const card = await sharp(CARD_SRC)
  .resize(CARD_W, CARD_H, { fit: 'cover' })
  .composite([
    { input: await sharp(cardMask).png().toBuffer(), blend: 'dest-in' },
  ])
  .png()
  .toBuffer();

const names = [...Object.keys(TIERS), 'prism'];
const TH_W = 320;
const TH_H = Math.round((TH_W * BAND_H) / BAND_W);
const GAP = 20;
const LABEL_H = 46;
const tiles = [];
for (const n of names) {
  const tile = await sharp({
    create: {
      width: BAND_W,
      height: BAND_H,
      channels: 4,
      background: { r: 23, g: 23, b: 23, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp(`${outDir}/${n}.webp`).png().toBuffer(),
        left: 0,
        top: 0,
      },
      { input: card, left: PAD, top: PAD },
    ])
    .png()
    .toBuffer();
  tiles.push(await sharp(tile).resize(TH_W, TH_H).png().toBuffer());
}
const sheetW = TH_W * names.length + GAP * (names.length + 1);
const sheetH = TH_H + GAP * 2 + LABEL_H;
const labels = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${sheetW}' height='${sheetH}'>${names
    .map(
      (t, i) =>
        `<text x='${GAP + i * (TH_W + GAP) + TH_W / 2}' y='${sheetH - 16}' text-anchor='middle' font-family='Segoe UI, Arial' font-size='26' fill='#fafafa'>${t}</text>`,
    )
    .join('')}</svg>`,
);
await sharp({
  create: {
    width: sheetW,
    height: sheetH,
    channels: 4,
    background: { r: 23, g: 23, b: 23, alpha: 1 },
  },
})
  .composite([
    ...tiles.map((input, i) => ({
      input,
      left: GAP + i * (TH_W + GAP),
      top: GAP,
    })),
    { input: await sharp(labels).png().toBuffer(), left: 0, top: 0 },
  ])
  .png()
  .toFile('docs/research/rawframe-tiers-sheet.png');

console.log(
  `done: ${outDir}/{${names.join(',')}}.webp + docs/research/rawframe-tiers-sheet.png`,
);
