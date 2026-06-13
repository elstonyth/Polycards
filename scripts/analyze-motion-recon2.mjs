// Digest pass 2: hero-curve2.json (img-rect tracking) + reveal2-track.json
// (slab -> metadata -> pull -> card). Appends to openpack-live/DIGEST.md.
import fs from 'node:fs';

const PACK = 'docs/research/openpack-live';
const PAGE = 'docs/research/motion-live';
const load = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function cubic(x1, y1, x2, y2) {
  const cx = 3 * x1,
    bx = 3 * (x2 - x1) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * y1,
    by = 3 * (y2 - y1) - cy,
    ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const solve = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = sx(t) - x;
      const ds = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-4 || ds === 0) break;
      t -= d / ds;
    }
    return t;
  };
  return (x) => {
    const t = solve(Math.min(1, Math.max(0, x)));
    return ((ay * t + by) * t + cy) * t;
  };
}
const BEZ = {
  linear: (t) => t,
  ease: cubic(0.25, 0.1, 0.25, 1),
  'ease-in': cubic(0.42, 0, 1, 1),
  'ease-out': cubic(0, 0, 0.58, 1),
  'ease-in-out': cubic(0.42, 0, 0.58, 1),
  'tw(0.4,0,0.2,1)': cubic(0.4, 0, 0.2, 1),
  'outCubic(0.22,0.61,0.36,1)': cubic(0.22, 0.61, 0.36, 1),
  'outQuint(0.22,1,0.36,1)': cubic(0.22, 1, 0.36, 1),
  'outBack(0.34,1.56,0.64,1)': cubic(0.34, 1.56, 0.64, 1),
  'inOutQuad(0.45,0,0.55,1)': cubic(0.45, 0, 0.55, 1),
};
const fitEase = (samples) => {
  let best = null;
  for (const [name, fn] of Object.entries(BEZ)) {
    const err =
      samples.reduce((a, s) => a + (fn(s.p) - s.v) ** 2, 0) /
      (samples.length || 1);
    if (!best || err < best.err) best = { name, err };
  }
  const over = Math.max(...samples.map((s) => s.v), 0);
  if (over > 1.04) best.name = `spring(+${(over * 100 - 100).toFixed(0)}%)`;
  return best.name;
};
const dec2d = (m) => ({
  sc: +Math.hypot(m[0], m[1]).toFixed(4),
  rot: +((Math.atan2(m[1], m[0]) * 180) / Math.PI).toFixed(2),
  tx: +m[4].toFixed(1),
  ty: +m[5].toFixed(1),
});
const dec3d = (m) => ({
  sc: +Math.hypot(m[0], m[1], m[2]).toFixed(4),
  rotY: +((Math.atan2(m[8], m[0]) * 180) / Math.PI).toFixed(2),
  tx: +m[12].toFixed(1),
  ty: +m[13].toFixed(1),
});
const parseT = (tr) => {
  if (!tr || tr === 'none' || tr === '') return {};
  const nums = tr.match(/-?[\d.e]+/g)?.map(Number) || [];
  if (tr.startsWith('matrix3d')) return dec3d(nums);
  if (tr.startsWith('matrix')) return dec2d(nums);
  return {};
};

const md = ['\n\n# ===== PASS 2 ====='];
const P = (s) => {
  md.push(s);
  console.log(s);
};

// -------------------- HERO --------------------
const hero = load(`${PAGE}/hero-curve2.json`);
if (hero?.frames?.length) {
  P(
    `\n## HERO v2 — ${hero.frames.length} frames over ${Math.round(hero.frames.at(-1).t)}ms`,
  );
  // theme = src stripped of digits/ext; series per theme: cx (avg), wo (max), wt scale
  const themes = new Map();
  for (const fr of hero.frames) {
    const by = new Map();
    for (const im of fr.imgs) {
      const t = im.src
        .replace(/\.(webp|avif|png)$/i, '')
        .replace(/[0-9]+$/, '');
      (by.get(t) || by.set(t, []).get(t)).push(im);
    }
    for (const [t, ims] of by) {
      const cx = Math.round(ims.reduce((a, c) => a + c.cx, 0) / ims.length);
      const wo = Math.max(...ims.map((c) => c.wo));
      const sc = parseT(ims[0].wt).sc ?? 1;
      (themes.get(t) || themes.set(t, []).get(t)).push({ t: fr.t, cx, wo, sc });
    }
  }
  for (const [name, series] of themes) {
    if (series.length < 20) continue;
    // find motion windows on cx
    const segs = [];
    let i = 0;
    while (i < series.length - 1) {
      if (Math.abs(series[i + 1].cx - series[i].cx) < 1) {
        i++;
        continue;
      }
      let j = i + 1,
        still = 0;
      while (j < series.length - 1 && still < 8) {
        if (Math.abs(series[j + 1].cx - series[j].cx) < 0.8) still++;
        else still = 0;
        j++;
      }
      const seg = series.slice(i, j + 1 - still);
      if (seg.length > 4) {
        const from = seg[0],
          to = seg.at(-1);
        const span = to.cx - from.cx || 1;
        const ease = fitEase(
          seg.map((s) => ({
            p: (s.t - from.t) / (to.t - from.t || 1),
            v: (s.cx - from.cx) / span,
          })),
        );
        segs.push(
          `t=${Math.round(from.t)} +${Math.round(to.t - from.t)}ms cx ${from.cx}->${to.cx} wo ${from.wo}->${to.wo} sc ${from.sc}->${to.sc} ${ease}`,
        );
      }
      i = j + 1;
    }
    P(`- ${name}: ${segs.length ? '' : 'STATIC'}`);
    segs.forEach((s) => P(`    ${s}`));
  }
  // период: время между начала окон движения первой темы
} else P('\n## HERO v2 — no data');

// -------------------- REVEAL 2 --------------------
const rev = load(`${PACK}/reveal2-track.json`);
if (rev?.frames?.length) {
  P(
    `\n## REVEAL v2 (slab tap -> card) — ${rev.frames.length} frames over ${Math.round(rev.frames.at(-1).t)}ms`,
  );
  let last = '';
  for (const fr of rev.frames) {
    const txt = (fr.txt || '').toUpperCase();
    let stage = null;
    if (/TAP TO REVEAL/.test(txt)) stage = 'slab';
    else if (
      /PULL •|PULL!|! PULL/.test(txt) ||
      (/PULL/.test(txt) && /•/.test(txt))
    )
      stage = 'pull';
    else if (/CONTINUE|OPEN ANOTHER|SELL|ADD TO/.test(txt)) stage = 'card';
    else if (/CATEGORY|GRADE|YEAR|\b(19|20)\d\d\b/.test(txt))
      stage = 'metadata';
    if (stage && stage !== last) {
      P(
        `- STAGE ${String(Math.round(fr.t)).padStart(6)}ms  ${stage.padEnd(9)} "${(fr.txt || '').slice(0, 90)}"`,
      );
      last = stage;
    }
  }
  // motion segments (same approach as pass 1, inline)
  const bySig = new Map();
  for (const fr of rev.frames)
    for (const n of fr.n) {
      const d = parseT(n.tr);
      (bySig.get(n.s) || bySig.set(n.s, []).get(n.s)).push({
        t: fr.t,
        o: n.o,
        ...d,
        an: n.an,
        bg: n.bg,
        y: n.y,
        x: n.x,
        w: n.w,
        h: n.h,
      });
    }
  P('### Motion segments:');
  const rows = [];
  for (const [sig, series] of bySig) {
    if (series.length < 4) continue;
    for (const prop of ['o', 'sc', 'rot', 'rotY', 'tx', 'ty']) {
      const vals = series
        .map((r) => ({
          t: r.t,
          v: typeof r[prop] === 'number' ? r[prop] : null,
        }))
        .filter((r) => r.v != null);
      if (vals.length < 4) continue;
      let i = 0;
      const eps = prop === 'o' ? 0.008 : 0.4;
      while (i < vals.length - 1) {
        if (Math.abs(vals[i + 1].v - vals[i].v) < eps * 0.25) {
          i++;
          continue;
        }
        let j = i + 1,
          still = 0;
        while (j < vals.length - 1 && still < 7) {
          if (Math.abs(vals[j + 1].v - vals[j].v) < eps * 0.15) still++;
          else still = 0;
          j++;
        }
        const seg = vals.slice(i, Math.max(i + 2, j + 1 - still));
        const from = seg[0].v,
          to = seg.at(-1).v,
          delta = Math.abs(to - from);
        if (delta >= (prop === 'o' ? 0.08 : 3)) {
          const t0 = seg[0].t,
            dur = seg.at(-1).t - t0;
          if (dur > 30 && dur < 5000) {
            const span = to - from || 1;
            const ease = fitEase(
              seg.map((s) => ({
                p: (s.t - t0) / (dur || 1),
                v: (s.v - from) / span,
              })),
            );
            rows.push({ t0, dur, prop, from, to, ease, sig });
          }
        }
        i = j + 1;
      }
    }
  }
  rows
    .sort((a, b) => a.t0 - b.t0)
    .forEach((s) =>
      P(
        `- t=${String(Math.round(s.t0)).padStart(6)} +${String(Math.round(s.dur)).padStart(4)}ms ${s.prop.padEnd(4)} ${String(+s.from.toFixed(2)).padStart(8)} -> ${String(+s.to.toFixed(2)).padEnd(8)} ${s.ease.padEnd(26)} ${s.sig.slice(0, 58)}`,
      ),
    );
  const anims = new Set();
  rev.frames.forEach((fr) =>
    fr.n.forEach((n) => n.an && anims.add(`${n.an}  [${n.s.slice(0, 46)}]`)),
  );
  const bgs = new Set();
  rev.frames.forEach((fr) =>
    fr.n.forEach((n) => {
      if (n.bg && n.bg !== 'rgba(0, 0, 0, 0)' && n.h < 220 && n.w > 800)
        bgs.add(`${n.bg} ${n.w}x${n.h} [${n.s.slice(0, 40)}]`);
    }),
  );
  if (anims.size) {
    P('### CSS animations seen:');
    [...anims].slice(0, 24).forEach((a) => P('- ' + a));
  }
  if (bgs.size) {
    P('### Wide colored bars (ribbon candidates):');
    [...bgs].slice(0, 12).forEach((b) => P('- ' + b));
  }
} else P('\n## REVEAL v2 — no data');

fs.appendFileSync(`${PACK}/DIGEST.md`, md.join('\n'));
console.log(`\nAPPENDED ${PACK}/DIGEST.md`);
