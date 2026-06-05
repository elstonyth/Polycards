// Composite "Pokenic" onto LaMa's cleaned banners, AUTO-MATCHING each machine's ORIGINAL
// phygitals wordmark so the rebrand keeps the same look/design/colour/position per machine:
//   • COLOUR  — sampled from the original (lama-in) at the masked wordmark pixels (the core
//               strokes, farthest from the banner background) → riftbound=gold, elite=red,
//               pokemon=purple, nba/soccer=white… measured, not assumed.
//   • POSITION— the mask bounding-box centre (where phygitals actually sat).
//   • SIZE    — fit to the wordmark's measured width.
//   • GLOW    — on for dark/glowing banners (bg luminance low), off for light banners.
// Text is drawn in the BROWSER (Poppins web font; PIL 9.5 mis-renders TTFs as .notdef).
// OVERRIDES{} can pin any value if a measurement is visibly off.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

const DIR = "public/images/claw";
const IN = "docs/research/packdetail/lama-in";    // ORIGINAL (with phygitals) — colour source
const OUT = "docs/research/packdetail/lama-out";   // LaMa-cleaned — draw target
const MASK = "docs/research/packdetail/lama-mask";

const ALL_BASES = [
  "mythic-pack", "legend-pack", "elite-pack", "platinum-pack", "rookie-pack", "trainer-pack",
  "starter-riftbound-pack", "black-pack-jjnfuk", "legend-pack-1dpaec", "modern-grails-noafw0", "pro-soccer-pack",
];
// optional argv filter: process only the named bases (so re-deriving one machine doesn't touch others)
const ONLY = process.argv.slice(2);
const BASES = ONLY.length ? ALL_BASES.filter((b) => ONLY.includes(b)) : ALL_BASES;
// Match the phygitals wordmark style: LOWERCASE "pokenic" (originals are lowercase), in
// Poppins 700 (the phygitals face), sized to the wordmark's LETTER HEIGHT (not stretched to
// width), baseline-aligned, FLAT (no glow) — except machines whose original wordmark glows.
const WORD = "pokenic";
const FSF = 0.78;   // font-size as a fraction of the measured wordmark bbox height (dilate-3 inflated)
const BASEF = 0.74; // baseline as a fraction down the bbox (so caps rise, 'p' descends, like phygitals)
// Per-base overrides: {color:[r,g,b], glow:bool, blur, fsf, basef, cxabs(0..1 absolute centre)}
const OVERRIDES = {
  // ornate plate: per-row interpolation smears the filigree, so use the LaMa fill here; gold
  // wordmark + soft glow; auto-sample picks the cyan glow not the gold, so pin gold.
  "starter-riftbound-pack": { lama: true, glow: true, blur: 0.16, color: [219, 177, 101] },
  // phygitals sat left over "SOCCER CLAW" (FIFA logo right) → centre on the plate per user.
  "pro-soccer-pack": { cxabs: 0.497 },
};

const orig = {}, outp = {}, masks = {};
for (const base of BASES) {
  orig[base] = "data:image/png;base64," + (await readFile(`${IN}/${base}.png`)).toString("base64");
  outp[base] = "data:image/png;base64," + (await readFile(`${OUT}/${base}.png`)).toString("base64");
  masks[base] = "data:image/png;base64," + (await readFile(`${MASK}/${base}.png`)).toString("base64");
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await page.addStyleTag({ content: "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@700&display=swap');" });
await page.waitForTimeout(1800);
await page.evaluate(async () => { try { await document.fonts.load("700 60px Poppins"); } catch {} });

const results = await page.evaluate(async ({ BASES, orig, outp, masks, OVERRIDES, WORD, FSF, BASEF }) => {
  const load = (s) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error("load")); im.src = s; });
  const med = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const out = {};
  for (const base of BASES) {
    const ov = OVERRIDES[base] || {};
    const oImg = await load(orig[base]);
    const cImg = await load(outp[base]);
    const mImg = await load(masks[base]);
    const W = oImg.naturalWidth, H = oImg.naturalHeight;
    const data = (img) => { const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0, W, H); return cx.getImageData(0, 0, W, H).data; };
    const od = data(oImg), mdata = data(mImg);

    // masked (= former wordmark) pixels + bbox
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1; const idx = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (mdata[(y * W + x) * 4] > 128) { idx.push([x, y]); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }

    // background colour = ORIGINAL pixels inside bbox but NOT masked
    const bgR = [], bgG = [], bgB = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) { const p = (y * W + x) * 4; if (mdata[p] <= 128) { bgR.push(od[p]); bgG.push(od[p + 1]); bgB.push(od[p + 2]); } }
    const bg = [med(bgR), med(bgG), med(bgB)];

    // wordmark colour = masked original pixels farthest from bg (core strokes), median
    const wm = idx.map(([x, y]) => { const p = (y * W + x) * 4; const r = od[p], g = od[p + 1], b = od[p + 2]; return { r, g, b, d: Math.hypot(r - bg[0], g - bg[1], b - bg[2]) }; }).sort((a, b) => b.d - a.d);
    const core = wm.slice(0, Math.max(1, Math.floor(wm.length * 0.45)));
    const color = ov.color || [med(core.map(c => c.r)), med(core.map(c => c.g)), med(core.map(c => c.b))];

    // Centre on the MEDIAN x of the wordmark pixels (robust = where phygitals actually sat),
    // not the bbox centre (which strays when the mask catches frame/glow pixels on one side).
    const xsAll = idx.map((p) => p[0]).sort((a, b) => a - b);
    const medX = xsAll.length ? xsAll[Math.floor(xsAll.length / 2)] : (minX + maxX) / 2;
    const cx = ov.cxabs != null ? ov.cxabs * W : medX;
    const bboxH = maxY - minY;
    const fs = Math.max(10, Math.round(bboxH * (ov.fsf ?? FSF)));
    const baseY = minY + bboxH * (ov.basef ?? BASEF); // alphabetic baseline → caps rise, 'p' descends
    const glow = ov.glow ?? false;

    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    if (ov.lama) {
      ctx.drawImage(cImg, 0, 0, W, H); // ornate → LaMa fill
    } else {
      // Flat/gradient banner: seamless HARMONIC (Laplace) infill of the masked wordmark area.
      // Solve ∇²=0 with the surrounding plate pixels (and the unmasked gaps between letters) as
      // FIXED boundary → the fill flows continuously out of the plate's own gradient/gloss, so
      // there's no box/streak/blur edge (the failure mode of interpolation & median fills).
      ctx.drawImage(oImg, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H); const px = id.data;
      const pad = 4;
      const x0 = Math.max(0, minX - pad), x1 = Math.min(W - 1, maxX + pad);
      const y0 = Math.max(0, minY - pad), y1 = Math.min(H - 1, maxY + pad);
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const isM = new Uint8Array(bw * bh);
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) isM[yy * bw + xx] = mdata[((y0 + yy) * W + (x0 + xx)) * 4] > 128 ? 1 : 0;
      for (let ch = 0; ch < 3; ch++) {
        const f = new Float32Array(bw * bh);
        let sum = 0, cnt = 0;
        for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) { const v = od[((y0 + yy) * W + (x0 + xx)) * 4 + ch]; f[yy * bw + xx] = v; if (!isM[yy * bw + xx]) { sum += v; cnt++; } }
        const seed = cnt ? sum / cnt : 0;
        for (let i = 0; i < bw * bh; i++) if (isM[i]) f[i] = seed;
        for (let it = 0; it < 500; it++) { // Gauss-Seidel in-place (fast convergence)
          for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
            const i = yy * bw + xx; if (!isM[i]) continue;
            const l = xx > 0 ? f[i - 1] : f[i + 1], r = xx < bw - 1 ? f[i + 1] : f[i - 1];
            const u = yy > 0 ? f[i - bw] : f[i + bw], d = yy < bh - 1 ? f[i + bw] : f[i - bw];
            f[i] = (l + r + u + d) * 0.25;
          }
        }
        for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) { const i = yy * bw + xx; if (isM[i]) { const p = ((y0 + yy) * W + (x0 + xx)) * 4; px[p + ch] = Math.round(f[i]); px[p + 3] = 255; } }
      }
      ctx.putImageData(id, 0, 0);
    }
    ctx.font = `700 ${fs}px Poppins, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const col = `rgb(${color[0]},${color[1]},${color[2]})`;
    ctx.fillStyle = col;
    if (glow) { ctx.shadowColor = col; ctx.shadowBlur = Math.round(fs * (ov.blur ?? 0.14)); ctx.fillText(WORD, cx, baseY); }
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    ctx.fillText(WORD, cx, baseY);

    out[base] = { ok: true, fs, color, bg, cx: +(cx / W * 100).toFixed(1), baseY: +(baseY / H * 100).toFixed(1), bboxH, glow };
    out[base].data = cv.toDataURL("image/webp", 0.95);
  }
  return out;
}, { BASES, orig, outp, masks, OVERRIDES, WORD, FSF, BASEF });

for (const [base, r] of Object.entries(results)) {
  await writeFile(`${DIR}/${base}-machine.webp`, Buffer.from(r.data.split(",")[1], "base64"));
  console.log(`${base}: color=rgb(${r.color}) bg=rgb(${r.bg}) glow=${r.glow} cx=${r.cx}% baseY=${r.baseY}% bboxH=${r.bboxH} fs=${r.fs}`);
}
await browser.close();
console.log(`\n${Object.keys(results).length} composed (auto-matched to original wordmark)`);
