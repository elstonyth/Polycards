/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Pair sheet + outline proof.
//   node scripts/pack-back/pair-sheet.cjs <pack>
// Row 1: front | matched back, on #0a0a0a.  Row 2: mirrored front at 50% over the original back,
// and over the matched back (outlines must coincide).  Prints outline mismatch before/after.
const path = require('path');
const { sharp, loadConfig, rawRGBA, rawRGB } = require('./lib.cjs');
const pack = process.argv[2];
const cfg = loadConfig(pack);
const BG = { r: 10, g: 10, b: 10 };
(async () => {
  const matched = path.join(cfg.outDir, `${cfg.name}-back-matched.png`);
  const F = await rawRGBA(cfg.front, { flop: true });
  const M = await rawRGBA(matched);
  const O = await rawRGB(cfg.backRef);
  const { W, H } = F;
  // outline mismatch (alpha >= 128 vs mirrored front alpha >= 128; original back: on black, max channel > 18)
  let before = 0,
    after = 0,
    alphaBytes = 0;
  for (let p = 0; p < W * H; p++) {
    const f = F.data[p * 4 + 3] >= 128;
    const o =
      Math.max(O.data[p * 3], O.data[p * 3 + 1], O.data[p * 3 + 2]) >
      cfg.back.edgeThreshold;
    const m = M.data[p * 4 + 3] >= 128;
    if (f !== o) before++;
    if (f !== m) after++;
    if (F.data[p * 4 + 3] !== M.data[p * 4 + 3]) alphaBytes++;
  }
  console.log(
    `outline mismatch (XOR px): before ${before}, after ${after}; alpha bytes differing ${alphaBytes}`,
  );
  if (cfg.frontWebp) {
    const Wp = await rawRGBA(cfg.frontWebp, { flop: true });
    let d = 0,
      dm = 0;
    for (let p = 0; p < W * H; p++) {
      const v = Math.abs(Wp.data[p * 4 + 3] - M.data[p * 4 + 3]);
      if (v) d++;
      if (v > dm) dm = v;
    }
    console.log(`vs mirrored webp front alpha: ${d} px differ (max ${dm})`);
  }

  const flat = (buf, w, h, ch) =>
    sharp(buf, { raw: { width: w, height: h, channels: ch } })
      .flatten({ background: BG })
      .png()
      .toBuffer();
  const front = await sharp(cfg.front)
    .flatten({ background: BG })
    .png()
    .toBuffer();
  const back = await sharp(matched)
    .flatten({ background: BG })
    .png()
    .toBuffer();
  // 50% overlays: mirrored front (flattened) blended with the other image
  const overlay = async (other, ch) => {
    const fl = await sharp(await flat(F.data, W, H, 4))
      .raw()
      .toBuffer();
    const ot = await sharp(await flat(other, W, H, ch))
      .raw()
      .toBuffer();
    const o = Buffer.alloc(W * H * 3);
    for (let i = 0; i < o.length; i++) o[i] = (fl[i] + ot[i] + 1) >> 1;
    return sharp(o, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toBuffer();
  };
  const ovBefore = await overlay(O.data, 3);
  const ovAfter = await overlay(M.data, 4);
  const gap = 40,
    pad = 40,
    label = 50;
  const SW = W * 2 + gap + pad * 2,
    SH = (H + label) * 2 + gap + pad * 2;
  const text = (s, x, y) => ({
    input: Buffer.from(
      `<svg width="${W}" height="${label}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="34" font-family="Segoe UI, Arial" font-size="28" fill="#cfcfcf">${s}</text></svg>`,
    ),
    left: x,
    top: y,
  });
  const r2 = pad + H + label + gap;
  await sharp({
    create: { width: SW, height: SH, channels: 3, background: BG },
  })
    .composite([
      text('Front', pad, pad),
      { input: front, left: pad, top: pad + label },
      text('Back (matched)', pad + W + gap, pad),
      { input: back, left: pad + W + gap, top: pad + label },
      text(`Mirrored front 50% over original back (${before} px off)`, pad, r2),
      { input: ovBefore, left: pad, top: r2 + label },
      text(
        `Mirrored front 50% over matched back (${after} px off)`,
        pad + W + gap,
        r2,
      ),
      { input: ovAfter, left: pad + W + gap, top: r2 + label },
    ])
    .png()
    .toFile(path.join(cfg.outDir, `${cfg.name}-pair-sheet.png`));
  console.log('wrote', path.join(cfg.outDir, `${cfg.name}-pair-sheet.png`));
})();
