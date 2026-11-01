// Builds the Lucky Draw frame ("Smoked", picked 2026-11-02) from its generated master:
// the art comes from Codex, the shape from the prism frame's own alpha, so it fits a
// slab exactly as every other frame does.
//
//   node scripts/compose-lucky-draw-frame.mjs <master.png>
//
// <master.png> is the 1600x2590 cut band. The raw-card band has a different shape, so
// it is nine-sliced from the same art at the raw band's thickness: corners kept, sides
// stretched along their length only, so the holo lines stay crisp and even.
import sharp from 'sharp';

const master = process.argv[2];
if (!master)
  throw new Error('usage: compose-lucky-draw-frame.mjs <master.png>');

const SLAB = 'public/images/slab-frames';
const RAW = 'public/images/raw-frames';

await sharp(master)
  .webp({ quality: 92, alphaQuality: 100 })
  .toFile(`${SLAB}/lucky-draw.webp`);

const { width: RW, height: RH } = await sharp(`${RAW}/prism.webp`).metadata();
// The slab band is about 90px at 1600 wide; the raw band is RAW_PAD 64 at 1240 wide.
const scale = 64 / 90;
const art = await sharp(master)
  .resize(Math.round(1600 * scale), Math.round(2590 * scale), {
    kernel: 'lanczos3',
  })
  .png()
  .toBuffer();
const { width: AW, height: AH } = await sharp(art).metadata();
const C = 170; // corner patch: past the rounded corner on both sides
const piece = (left, top, width, height) =>
  sharp(art).extract({ left, top, width, height }).png().toBuffer();
const stretch = async (buf, width, height) =>
  sharp(buf)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();

const parts = [
  { input: await piece(0, 0, C, C), left: 0, top: 0 },
  { input: await piece(AW - C, 0, C, C), left: RW - C, top: 0 },
  { input: await piece(0, AH - C, C, C), left: 0, top: RH - C },
  { input: await piece(AW - C, AH - C, C, C), left: RW - C, top: RH - C },
  {
    input: await stretch(await piece(C, 0, AW - 2 * C, C), RW - 2 * C, C),
    left: C,
    top: 0,
  },
  {
    input: await stretch(await piece(C, AH - C, AW - 2 * C, C), RW - 2 * C, C),
    left: C,
    top: RH - C,
  },
  {
    input: await stretch(await piece(0, C, C, AH - 2 * C), C, RH - 2 * C),
    left: 0,
    top: C,
  },
  {
    input: await stretch(await piece(AW - C, C, C, AH - 2 * C), C, RH - 2 * C),
    left: RW - C,
    top: C,
  },
];
// The band only: the prism raw band's alpha cuts the window and the outer edge.
const alpha = await sharp(`${RAW}/prism.webp`)
  .extractChannel('alpha')
  .toBuffer();
const flat = await sharp({
  create: {
    width: RW,
    height: RH,
    channels: 3,
    background: { r: 0, g: 0, b: 0 },
  },
})
  .composite(parts)
  .removeAlpha()
  .png()
  .toBuffer();
await sharp(flat)
  .joinChannel(alpha)
  .webp({ quality: 92, alphaQuality: 100 })
  .toFile(`${RAW}/lucky-draw.webp`);
console.log('slab and raw bands written');
