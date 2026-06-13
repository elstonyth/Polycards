// FULL rebrand for the two PREMIUM pokemon machines (black-pack red-neon / diamond-pack crystal)
// ONLY — kept separate from the shared rebrand-claw-final.mjs / rebrand_bottom.mjs so the 16 existing
// machines are never touched. These two sit on the busiest backgrounds (orange-neon glow / crystalline
// refraction) where the stroke-inpaint used elsewhere leaves a readable silhouette, so every brand
// zone is BLUR-PATCHED (downscale→upscale kills legible text but keeps the local glow/gradient) and
// the new text is drawn on top. Zones:
//   banner   "phygitals" -> "Pokenic"      (blur + neon redraw; frozen by make_patch BAND)
//   placard  "phygitals" -> "pokenic"      (line 1 only; "claw." + serial text left untouched)
//   url      "phygitals.com" -> "pokenic.com"
//   refl     diamond's mirrored url reflection -> blurred away (no redraw)
// Writes <base>-machine.webp (the still) AND the bottom-mask docs/research/.../bottom-mask/<base>.png
// (placard+url+refl boxes) that make_patch.py freezes onto every animation frame. Needs :4000 for the
// Poppins font. Positions MEASURED + crop-verified (docs jobs tmp zz_*/bnr*/fin*), not eyeballed.
import { chromium } from 'playwright';
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const DIR = 'public/images/claw';
const MASKDIR = 'docs/research/packdetail/bottom-mask';
// erase = [x0,x1,y0,y1] box (%). draw: align left|center, x (%), y/baseline (%), fs (px), color, glow.
// banner draw uses y as the vertical CENTRE (textBaseline middle); placard/url use baseline (alphabetic).
const JOBS = [
  {
    base: 'black-pack',
    file: 'black-pack-machine.avif',
    zones: [
      {
        kind: 'banner',
        erase: [29, 70, 15.0, 21.8],
        mask: false,
        draw: {
          text: 'Pokenic',
          align: 'center',
          x: 48.5,
          y: 18.6,
          fs: 58,
          color: 'rgb(252,233,208)',
          glow: ['rgba(255,120,50,0.6)', 16],
        },
      },
      {
        kind: 'placard',
        erase: [39.4, 47.8, 75.6, 78.0],
        mask: true,
        draw: {
          text: 'pokenic',
          align: 'left',
          x: 39.9,
          baseline: 77.5,
          fs: 18,
          color: 'rgb(34,30,34)',
        },
      },
      {
        kind: 'url',
        erase: [37.4, 51.8, 86.2, 89.4],
        mask: true,
        draw: {
          text: 'pokenic.com',
          align: 'center',
          x: 44.6,
          baseline: 88.6,
          fs: 14,
          color: 'rgb(236,236,239)',
        },
      },
    ],
  },
  {
    base: 'diamond-pack',
    file: 'diamond-pack-machine.avif',
    zones: [
      {
        kind: 'banner',
        erase: [29, 70, 14.5, 21.6],
        mask: false,
        draw: {
          text: 'Pokenic',
          align: 'center',
          x: 48.3,
          y: 18.4,
          fs: 58,
          color: 'rgb(247,249,255)',
          glow: ['rgba(150,190,255,0.5)', 12],
        },
      },
      {
        kind: 'placard',
        erase: [39.6, 47.8, 74.3, 76.9],
        mask: true,
        draw: {
          text: 'pokenic',
          align: 'left',
          x: 40.0,
          baseline: 76.4,
          fs: 18,
          color: 'rgb(34,30,40)',
        },
      },
      {
        kind: 'url',
        erase: [37.4, 52.0, 85.4, 88.4],
        mask: true,
        draw: {
          text: 'pokenic.com',
          align: 'center',
          x: 44.7,
          baseline: 87.4,
          fs: 14,
          color: 'rgb(236,238,242)',
        },
      },
      { kind: 'refl', erase: [37.4, 52.0, 88.6, 91.9], mask: true },
    ],
  },
];

await mkdir(MASKDIR, { recursive: true });
const inputs = {};
for (const j of JOBS)
  inputs[j.base] =
    `data:image/avif;base64,${(await readFile(`${DIR}/${j.file}`)).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.addStyleTag({
  content:
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&display=swap');",
});
await page.waitForTimeout(1800);
await page.evaluate(async () => {
  await document.fonts.ready;
  const a = await document.fonts.load('700 50px Poppins');
  const b = await document.fonts.load('600 30px Poppins');
  if (!a.length || !b.length) throw new Error('Poppins failed to load');
});

const results = await page.evaluate(
  async ({ JOBS, inputs }) => {
    const load = (s) =>
      new Promise((ok, no) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => no(new Error('load'));
        im.src = s;
      });
    const out = {};
    for (const j of JOBS) {
      const img = await load(inputs[j.base]);
      const W = img.naturalWidth,
        H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      // mask canvas (black; white = freeze) for the non-banner zones
      const mk = document.createElement('canvas');
      mk.width = W;
      mk.height = H;
      const mc = mk.getContext('2d');
      mc.fillStyle = '#000';
      mc.fillRect(0, 0, W, H);

      for (const z of j.zones) {
        const x0 = Math.round((z.erase[0] / 100) * W),
          x1 = Math.round((z.erase[1] / 100) * W);
        const y0 = Math.round((z.erase[2] / 100) * H),
          y1 = Math.round((z.erase[3] / 100) * H);
        const bw = x1 - x0,
          bh = y1 - y0;
        // BLUR-PATCH erase: downscale hard then upscale (+ small canvas blur) → no legible text, keeps tone.
        const sw = Math.max(
          2,
          Math.round(bw / (z.kind === 'banner' ? 22 : 14)),
        );
        const sh = Math.max(2, Math.round(bh / (z.kind === 'banner' ? 5 : 4)));
        const tmp = document.createElement('canvas');
        tmp.width = sw;
        tmp.height = sh;
        const tctx = tmp.getContext('2d');
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(cv, x0, y0, bw, bh, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(2px)';
        ctx.drawImage(tmp, 0, 0, sw, sh, x0, y0, bw, bh);
        ctx.filter = 'none';

        if (z.draw) {
          const dr = z.draw;
          let fs = dr.fs;
          if (z.kind === 'banner') {
            const maxW = bw * 0.62;
            ctx.font = `700 ${fs}px Poppins, sans-serif`;
            while (ctx.measureText(dr.text).width > maxW && fs > 12) fs -= 1;
          }
          ctx.font = `${z.kind === 'banner' ? 700 : 600} ${fs}px Poppins, sans-serif`;
          ctx.textAlign = dr.align;
          ctx.fillStyle = dr.color;
          if (z.kind === 'banner') {
            ctx.textBaseline = 'middle';
            if (dr.glow) {
              ctx.shadowColor = dr.glow[0];
              ctx.shadowBlur = dr.glow[1];
              ctx.fillText(dr.text, (dr.x / 100) * W, (dr.y / 100) * H);
            }
            ctx.fillText(dr.text, (dr.x / 100) * W, (dr.y / 100) * H);
            ctx.shadowBlur = 0;
          } else {
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(dr.text, (dr.x / 100) * W, (dr.baseline / 100) * H);
          }
        }
        if (z.mask) {
          mc.fillStyle = '#fff';
          mc.fillRect(x0, y0, bw, bh);
        }
      }
      out[j.base] = {
        webp: cv.toDataURL('image/webp', 0.95),
        mask: mk.toDataURL('image/png'),
      };
    }
    return out;
  },
  { JOBS, inputs },
);

let n = 0;
for (const [base, r] of Object.entries(results)) {
  await writeFile(
    `${DIR}/${base}-machine.webp`,
    Buffer.from(r.webp.split(',')[1], 'base64'),
  );
  await writeFile(
    `${MASKDIR}/${base}.png`,
    Buffer.from(r.mask.split(',')[1], 'base64'),
  );
  n++;
  console.log(
    `${base}: rebranded (banner+placard+url${base === 'diamond-pack' ? '+refl' : ''}) + mask`,
  );
}
console.log(`${n} premium machine(s) rebranded`);
await browser.close();
