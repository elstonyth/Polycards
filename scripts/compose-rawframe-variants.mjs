// Raw-card frame candidates — the ungraded twin of the graded slab's tier
// frame. Geometry is MEASURED, not eyeballed, so a raw card renders at the
// exact card-art size a graded tile shows:
//
//   slab window width  = 1 − 0.1094 − 0.1087            (bake-slab SLAB_WINDOW)
//   card in window     = winW − 2·round(winW·0.0063)     (composeSlab recess)
//                      = 1235px on a 1600-wide slab      (0.7719 of slab W)
//   framed tile        = slab at 5% inset (SlabImage)    → card = 0.7719 × 0.9
//   ⇒ on the 1600×2700 SLAB_ASPECT box: card = 1112×1557 at (244, 572), r 53
//     (storefront raw clip 4.8%/3.4% of the card box ≈ uniform 53px).
//
// Variants are PROCEDURAL (SVG → sharp), neutral dark — the picked one gets
// per-tier hue tints later, same as public/images/slab-frames/*. Each emits a
// transparent *-band.png (usable directly as the frame asset) + a preview on
// the neutral-900 tile background; the sheet leads with a real graded tile
// (common tier band + baked slab) so size can be compared apples-to-apples.
//
// usage: node scripts/compose-rawframe-variants.mjs
import sharp from 'sharp';

const BOX_W = 1600;
const BOX_H = 2700;
const CARD_W = 1112;
const CARD_H = 1557;
const CARD_X = (BOX_W - CARD_W) / 2; // 244
const CARD_Y = Math.round((BOX_H - CARD_H) / 2); // 572 (571.5 rounded)
const CARD_R = 53;

const CARD_SRC =
  'backend/packages/api/static/1784167279907-pc-fsbqea5aod5mejp5-1600.webp';
const SLAB_SRC =
  'backend/packages/api/static/1784350156865-slab-mega-charizard-x-ex-125-psa-10-11069001-0ac836b1.webp';
const TIER_BAND = 'public/images/slab-frames/common.webp';
const OUT = 'docs/research';

const rr = (x, y, w, h, r) => {
  const x1 = x + w;
  const y1 = y + h;
  return (
    `M${x + r},${y}H${x1 - r}A${r},${r} 0 0 1 ${x1},${y + r}V${y1 - r}` +
    `A${r},${r} 0 0 1 ${x1 - r},${y1}H${x + r}A${r},${r} 0 0 1 ${x},${y1 - r}` +
    `V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`
  );
};
const svg = (body, w = BOX_W, h = BOX_H) =>
  Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' width='${w}' height='${h}'>${body}</svg>`,
  );

// Band ring path: outer rounded rect minus the card window (evenodd hole).
const ring = (pad, padTop = pad, padBottom = pad, extraR = pad) =>
  `<path fill-rule='evenodd' d='${rr(
    CARD_X - pad,
    CARD_Y - padTop,
    CARD_W + 2 * pad,
    CARD_H + padTop + padBottom,
    CARD_R + extraR,
  )} ${rr(CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R)}'`;

// ---- variant band SVGs (transparent outside, hole over the card) -----------

const variants = {
  // 1 · dark smoked glass, same visual weight as the slab tier band (64px).
  'rawframe-1-glass-border': svg(
    `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
       <stop offset='0' stop-color='#2e2e33'/><stop offset='.5' stop-color='#1b1b1f'/>
       <stop offset='1' stop-color='#26262b'/></linearGradient></defs>
     ${ring(64)} fill='url(#g)' opacity='0.96'/>
     ${ring(64)} fill='none' stroke='rgba(255,255,255,0.14)' stroke-width='3'/>
     <path d='${rr(CARD_X - 2, CARD_Y - 2, CARD_W + 4, CARD_H + 4, CARD_R + 2)}'
       fill='none' stroke='rgba(255,255,255,0.28)' stroke-width='3'/>`,
  ),

  // 2 · thin brushed-metal hairline (26px) — quieter, lets the card dominate.
  'rawframe-2-metal-hairline': svg(
    `<defs><linearGradient id='m' x1='0' y1='0' x2='1' y2='1'>
       <stop offset='0' stop-color='#d9d9de'/><stop offset='.35' stop-color='#8b8b92'/>
       <stop offset='.6' stop-color='#c6c6cc'/><stop offset='1' stop-color='#77777e'/>
     </linearGradient></defs>
     ${ring(26)} fill='url(#m)'/>
     ${ring(26)} fill='none' stroke='rgba(0,0,0,0.45)' stroke-width='2'/>
     <path d='${rr(CARD_X - 1, CARD_Y - 1, CARD_W + 2, CARD_H + 2, CARD_R + 1)}'
       fill='none' stroke='rgba(0,0,0,0.5)' stroke-width='2'/>`,
  ),

  // 3 · toploader sleeve — clear plastic with the classic tall lip, the
  // physical way a raw card actually ships (graded gets a slab, raw gets a
  // toploader).
  'rawframe-3-toploader': svg(
    `${ring(46, 116, 46, 20)} fill='rgba(255,255,255,0.07)'/>
     ${ring(46, 116, 46, 20)} fill='none' stroke='rgba(255,255,255,0.34)' stroke-width='6'/>
     ${ring(46, 116, 46, 20)} fill='none' stroke='rgba(255,255,255,0.10)' stroke-width='16'/>
     <polygon points='${CARD_X - 46},${CARD_Y + 240} ${CARD_X + 260},${CARD_Y - 116} ${CARD_X + 420},${CARD_Y - 116} ${CARD_X - 46},${CARD_Y + 430}'
       fill='rgba(255,255,255,0.08)'/>`,
  ),

  // 4 · float — near-frameless: an 8px rim only; the tier glow does the rest
  // at runtime (matches the slab halo treatment, minimum added chrome).
  'rawframe-4-float-rim': svg(
    `${ring(8, 8, 8, 4)} fill='rgba(255,255,255,0.22)'/>
     ${ring(8, 8, 8, 4)} fill='none' stroke='rgba(255,255,255,0.30)' stroke-width='2'/>`,
  ),
};

// ---- compose ---------------------------------------------------------------

const cardMask = svg(
  `<path fill='white' d='${rr(0, 0, CARD_W, CARD_H, CARD_R)}'/>`,
  CARD_W,
  CARD_H,
);
const card = await sharp(CARD_SRC)
  .resize(CARD_W, CARD_H, { fit: 'cover' })
  .composite([
    { input: await sharp(cardMask).png().toBuffer(), blend: 'dest-in' },
  ])
  .png()
  .toBuffer();

const tile = () =>
  sharp({
    create: {
      width: BOX_W,
      height: BOX_H,
      channels: 4,
      background: { r: 23, g: 23, b: 23, alpha: 1 },
    },
  });

const previews = [];
const labels = [];

// Reference tile — a real graded tile exactly as SlabImage renders it:
// tier band (1600×2590 at y 55) + baked slab at the 5% inset.
{
  const band = await sharp(TIER_BAND).png().toBuffer();
  const slab = await sharp(SLAB_SRC)
    .resize(Math.round(BOX_W * 0.9), Math.round(BOX_H * 0.9), {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const ref = await tile()
    .composite([
      { input: band, left: 0, top: 55 },
      {
        input: slab,
        left: Math.round(BOX_W * 0.05),
        top: Math.round(BOX_H * 0.05),
      },
    ])
    .png()
    .toBuffer();
  previews.push(ref);
  labels.push('GRADED (reference)');
  await sharp(ref).toFile(`${OUT}/rawframe-0-graded-reference.png`);
}

for (const [name, bandSvg] of Object.entries(variants)) {
  const band = await sharp(bandSvg).png().toBuffer();
  await sharp(band).toFile(`${OUT}/${name}-band.png`);
  const preview = await tile()
    .composite([
      { input: band, left: 0, top: 0 },
      { input: card, left: CARD_X, top: CARD_Y },
    ])
    .png()
    .toBuffer();
  previews.push(preview);
  labels.push(name.replace(/^rawframe-/, '').replace(/-/g, ' '));
  await sharp(preview).toFile(`${OUT}/${name}-preview.png`);
}

// ---- comparison sheet ------------------------------------------------------

const TH_W = 440;
const TH_H = Math.round((TH_W * BOX_H) / BOX_W);
const GAP = 24;
const LABEL_H = 56;
const thumbs = await Promise.all(
  previews.map((p) => sharp(p).resize(TH_W, TH_H).png().toBuffer()),
);
const sheetW = TH_W * thumbs.length + GAP * (thumbs.length + 1);
const sheetH = TH_H + GAP * 2 + LABEL_H;
const labelSvg = svg(
  labels
    .map(
      (t, i) =>
        `<text x='${GAP + i * (TH_W + GAP) + TH_W / 2}' y='${sheetH - 22}' text-anchor='middle' font-family='Segoe UI, Arial' font-size='30' fill='#fafafa'>${t}</text>`,
    )
    .join(''),
  sheetW,
  sheetH,
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
    ...thumbs.map((input, i) => ({
      input,
      left: GAP + i * (TH_W + GAP),
      top: GAP,
    })),
    { input: await sharp(labelSvg).png().toBuffer(), left: 0, top: 0 },
  ])
  .png()
  .toFile(`${OUT}/rawframe-variants-sheet.png`);

console.log(
  `done: ${OUT}/rawframe-variants-sheet.png + per-variant *-band/-preview.png`,
);
