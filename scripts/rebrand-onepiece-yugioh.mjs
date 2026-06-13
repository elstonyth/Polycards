// Rebrand the BOTTOM brand zones of the One Piece (elite/legend/starter) + Yu-Gi-Oh claw machines from
// phygitals -> pokenic. Unlike the pokemon machines these have NO top "phygitals" banner (the top is the
// tier name / "PR-OH"), so we only touch bottom-pedestal zones:
//   url      "Phygitals.com" -> "Pokenic.com"   (bold, on a box face — flat)
//   placard  "phygitals"      -> "pokenic"        (yugioh only; line 1 of the "phygitals / claw." placard)
//   badge    "by phygitals"   -> "by pokenic"     (small text on the "RIP & REVEAL" pill; mild skew)
// Each zone is BLUR-PATCHED (downscale->upscale kills legible text but keeps the local box tone) then the
// new text is redrawn. Writes <base>-machine.webp (the rebranded still, regenerated from the AVIF frame0 at
// native res so it matches the pixels the bake composites onto) AND the bottom-mask
// docs/research/packdetail/bottom-mask/<base>.png (url+placard+badge boxes) that make_patch.py freezes onto
// every animation frame. Needs :4000 for the Poppins font. Coords measured/iterated on the AVIF frame0.
import { chromium } from 'playwright';
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const DIR = 'public/images/claw';
const MASKDIR = 'docs/research/packdetail/bottom-mask';
// erase = [x0,y0,x1,y1] px box on the AVIF frame0. draw.x/baseline in px. align left|center.
// kind "badge" supports draw.rot (degrees) about the text anchor for mild box-face skew.
const JOBS = [
  {
    base: 'elite-one-piece-pack',
    file: 'elite-one-piece-pack-machine.avif',
    zones: [
      {
        kind: 'url',
        erase: [556, 860, 714, 904],
        draw: {
          text: 'Pokenic.com',
          align: 'center',
          x: 635,
          baseline: 895,
          fs: 30,
          color: 'rgb(245,245,245)',
        },
      },
      {
        kind: 'badge',
        erase: [704, 812, 830, 854],
        draw: {
          text: 'by pokenic',
          align: 'center',
          x: 767,
          baseline: 838,
          fs: 15,
          color: 'rgb(40,28,22)',
          rot: 0,
        },
      },
    ],
  },
  {
    base: 'legend-one-piece-pack',
    file: 'legend-one-piece-pack-machine.avif',
    zones: [
      {
        kind: 'url',
        erase: [452, 864, 694, 908],
        draw: {
          text: 'Pokenic.com',
          align: 'center',
          x: 573,
          baseline: 898,
          fs: 28,
          color: 'rgb(248,240,214)',
        },
      },
      {
        kind: 'badge',
        erase: [686, 848, 858, 884],
        draw: {
          text: 'by pokenic',
          align: 'center',
          x: 772,
          baseline: 873,
          fs: 14,
          color: 'rgb(48,38,20)',
          rot: 0,
        },
      },
    ],
  },
  {
    base: 'starter-one-piece-pack',
    file: 'starter-one-piece-pack-machine.avif',
    zones: [
      {
        kind: 'url',
        erase: [470, 872, 706, 916],
        draw: {
          text: 'Pokenic.com',
          align: 'center',
          x: 588,
          baseline: 906,
          fs: 29,
          color: 'rgb(248,246,248)',
        },
      },
      {
        kind: 'badge',
        erase: [700, 832, 826, 860],
        draw: {
          text: 'by pokenic',
          align: 'center',
          x: 763,
          baseline: 852,
          fs: 14,
          color: 'rgb(60,40,48)',
          rot: 0,
        },
      },
    ],
  },
  // Yu-Gi-Oh (1440x900): placard "phygitals/claw." line 1 only, url, and the RIP&REVEAL pill.
  {
    base: 'yugioh-pro-pack',
    file: 'yugioh-pro-pack-machine.avif',
    zones: [
      {
        kind: 'placard',
        erase: [548, 718, 700, 744],
        solid: true,
        draw: {
          text: 'pokenic',
          align: 'left',
          x: 552,
          baseline: 738,
          fs: 17,
          color: 'rgb(235,110,75)',
        },
      },
      {
        kind: 'url',
        erase: [506, 838, 676, 868],
        draw: {
          text: 'Pokenic.com',
          align: 'center',
          x: 590,
          baseline: 862,
          fs: 20,
          color: 'rgb(245,250,245)',
        },
      },
      {
        kind: 'badge',
        erase: [740, 804, 876, 828],
        draw: {
          text: 'by pokenic',
          align: 'center',
          x: 808,
          baseline: 821,
          fs: 14,
          color: 'rgb(40,40,38)',
          rot: 0,
        },
      },
    ],
  },
];

await mkdir(MASKDIR, { recursive: true });
const inputs = {};
for (const j of JOBS) {
  const im = Image_dataurl(await readFile(`${DIR}/${j.file}`));
  inputs[j.base] = im;
}
function Image_dataurl(buf) {
  return `data:image/avif;base64,${buf.toString('base64')}`;
}

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
  const a = await document.fonts.load('700 40px Poppins');
  const b = await document.fonts.load('600 24px Poppins');
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
      const mk = document.createElement('canvas');
      mk.width = W;
      mk.height = H;
      const mc = mk.getContext('2d');
      mc.fillStyle = '#000';
      mc.fillRect(0, 0, W, H);

      for (const z of j.zones) {
        const [x0, y0, x1, y1] = z.erase;
        const bw = x1 - x0,
          bh = y1 - y0;
        // CLEAN VERTICAL-GRADIENT FILL erase (NOT blur — blur leaves a visible soft smudge box at 4K on
        // these flatter box faces). For each column, sample the clean background at the box's top & bottom
        // edges (text-free margin) and fill that column with a smooth vertical interpolation, replacing the
        // glyphs in the middle with surface-matched tone. Keeps the box CRISP and the surface's L-R colour /
        // shading; no halo. The redraw then sits on a clean surface. (Boxes are kept WITHIN one flat surface
        // — pill / card / box face — so the two edges share the surface and the gradient stays true.)
        const SMP = Math.max(2, Math.min(4, Math.floor(bh / 4)));
        const id = ctx.getImageData(x0, y0, bw, bh);
        const px = id.data;
        if (z.solid) {
          // SOLID fill from the clean TOP edge — for flat cards (the placard) whose text has descenders that
          // reach the box's BOTTOM edge and would pollute a gradient's lower sample. The card tone is uniform,
          // so a single colour covers the glyphs (incl. descenders) cleanly.
          let r = 0,
            g = 0,
            b = 0,
            c = 0;
          for (let k = 0; k < SMP; k++)
            for (let xx = 0; xx < bw; xx++) {
              const i = (k * bw + xx) * 4;
              r += px[i];
              g += px[i + 1];
              b += px[i + 2];
              c++;
            }
          r /= c;
          g /= c;
          b /= c;
          for (let i = 0; i < px.length; i += 4) {
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
          }
        } else {
          for (let xx = 0; xx < bw; xx++) {
            let tr = 0,
              tg = 0,
              tb = 0,
              br = 0,
              bg = 0,
              bb = 0;
            for (let k = 0; k < SMP; k++) {
              const i = (k * bw + xx) * 4;
              tr += px[i];
              tg += px[i + 1];
              tb += px[i + 2];
              const j = ((bh - 1 - k) * bw + xx) * 4;
              br += px[j];
              bg += px[j + 1];
              bb += px[j + 2];
            }
            tr /= SMP;
            tg /= SMP;
            tb /= SMP;
            br /= SMP;
            bg /= SMP;
            bb /= SMP;
            for (let yy = 0; yy < bh; yy++) {
              const t = bh > 1 ? yy / (bh - 1) : 0;
              const i = (yy * bw + xx) * 4;
              px[i] = tr + (br - tr) * t;
              px[i + 1] = tg + (bg - tg) * t;
              px[i + 2] = tb + (bb - tb) * t;
            }
          }
        }
        ctx.putImageData(id, x0, y0);

        if (z.draw) {
          const dr = z.draw;
          ctx.save();
          ctx.font = `${z.kind === 'url' ? 700 : 700} ${dr.fs}px Poppins, sans-serif`;
          ctx.textAlign = dr.align;
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = dr.color;
          if (dr.rot) {
            ctx.translate(dr.x, dr.baseline);
            ctx.rotate((dr.rot * Math.PI) / 180);
            ctx.fillText(dr.text, 0, 0);
          } else ctx.fillText(dr.text, dr.x, dr.baseline);
          ctx.restore();
        }
        // freeze every rebranded zone in the bottom mask
        mc.fillStyle = '#fff';
        mc.fillRect(x0, y0, bw, bh);
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
    `${base}: rebranded ${JOBS.find((j) => j.base === base)
      .zones.map((z) => z.kind)
      .join('+')} + mask`,
  );
}
console.log(`${n} machine(s) rebranded`);
await browser.close();
