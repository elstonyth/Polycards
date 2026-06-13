// Distill the rAF recon JSONs (recon-motion-live.mjs output) into the numbers the
// Framer Motion rebuild needs: per-element motion segments with duration, value
// ranges, decomposed transforms, overshoot, and a best-fit easing label.
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

// ---- transform decomposition ----
const dec2d = (m) => {
  // matrix(a,b,c,d,tx,ty)
  const [a, b, , , tx, ty] = m;
  return {
    sc: +Math.hypot(a, b).toFixed(4),
    rot: +((Math.atan2(b, a) * 180) / Math.PI).toFixed(2),
    tx: +tx.toFixed(1),
    ty: +ty.toFixed(1),
  };
};
const dec3d = (m) => {
  // column-major matrix3d; rotateY -> m0=cos, m8=sin; translate in m12..14
  const rotY = +((Math.atan2(m[8], m[0]) * 180) / Math.PI).toFixed(2);
  const sc = +Math.hypot(m[0], m[1], m[2]).toFixed(4);
  return {
    sc,
    rotY,
    tx: +m[12].toFixed(1),
    ty: +m[13].toFixed(1),
    tz: +m[14].toFixed(1),
  };
};
const parseT = (tr) => {
  if (!tr || tr === 'none') return { kind: 'none' };
  const nums = tr.match(/-?[\d.e]+/g)?.map(Number) || [];
  if (tr.startsWith('matrix3d')) return { kind: '3d', ...dec3d(nums) };
  if (tr.startsWith('matrix')) return { kind: '2d', ...dec2d(nums) };
  return { kind: 'raw', raw: tr.slice(0, 60) };
};

// ---- easing fit: normalized progress samples -> closest standard curve ----
const BEZ = {
  linear: (t) => t,
  ease: cubic(0.25, 0.1, 0.25, 1),
  'ease-in': cubic(0.42, 0, 1, 1),
  'ease-out': cubic(0, 0, 0.58, 1),
  'ease-in-out': cubic(0.42, 0, 0.58, 1),
  'tw-default(0.4,0,0.2,1)': cubic(0.4, 0, 0.2, 1),
  'easeOutCubic(0.22,0.61,0.36,1)': cubic(0.22, 0.61, 0.36, 1),
  'easeOutQuint(0.22,1,0.36,1)': cubic(0.22, 1, 0.36, 1),
  'easeOutBack(0.34,1.56,0.64,1)': cubic(0.34, 1.56, 0.64, 1),
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
const fitEase = (samples) => {
  // samples: [{p: 0..1 time, v: 0..1 progress}]
  let best = null;
  for (const [name, fn] of Object.entries(BEZ)) {
    const err =
      samples.reduce((a, s) => a + (fn(s.p) - s.v) ** 2, 0) / samples.length;
    if (!best || err < best.err) best = { name, err: +err.toFixed(5) };
  }
  const over = Math.max(...samples.map((s) => s.v));
  if (over > 1.04)
    best.name = `spring(overshoot ${(over * 100 - 100).toFixed(0)}%)`;
  return best;
};

// ---- per-sig series -> motion segments ----
function segments(
  track,
  { minDelta = 0.5, props = ['o', 'sc', 'rot', 'rotY', 'tx', 'ty'] } = {},
) {
  const bySig = new Map();
  for (const fr of track.frames) {
    for (const n of fr.n) {
      const d = parseT(n.tr);
      const rec = {
        t: fr.t,
        o: n.o,
        ...d,
        x: n.x,
        y: n.y,
        w: n.w,
        an: n.an,
        f: n.f,
      };
      (bySig.get(n.s) || bySig.set(n.s, []).get(n.s)).push(rec);
    }
  }
  const out = [];
  for (const [sig, series] of bySig) {
    if (series.length < 4) continue;
    for (const prop of props) {
      const vals = series
        .map((r) => ({
          t: r.t,
          v: typeof r[prop] === 'number' ? r[prop] : null,
        }))
        .filter((r) => r.v != null);
      if (vals.length < 4) continue;
      // find change windows
      let i = 0;
      while (i < vals.length - 1) {
        if (
          Math.abs(vals[i + 1].v - vals[i].v) <
          (prop === 'o' ? 0.01 : minDelta) * 0.2
        ) {
          i++;
          continue;
        }
        let j = i + 1;
        let still = 0;
        while (j < vals.length - 1 && still < 6) {
          if (
            Math.abs(vals[j + 1].v - vals[j].v) <
            (prop === 'o' ? 0.005 : minDelta * 0.1)
          )
            still++;
          else still = 0;
          j++;
        }
        const seg = vals.slice(i, j + 1);
        const from = seg[0].v,
          to = seg[seg.length - 1 - Math.min(still, seg.length - 1)].v;
        const delta = Math.abs(to - from);
        if (delta >= (prop === 'o' ? 0.05 : minDelta)) {
          const t0 = seg[0].t,
            t1 = seg[Math.max(0, seg.length - 1 - still)].t;
          const dur = t1 - t0;
          if (dur > 30 && dur < 6000) {
            const span = to - from || 1;
            const samples = seg
              .filter((s) => s.t <= t1)
              .map((s) => ({
                p: (s.t - t0) / (dur || 1),
                v: (s.v - from) / span,
              }));
            out.push({
              sig: sig.slice(0, 60),
              prop,
              t0: Math.round(t0),
              dur: Math.round(dur),
              from: +from.toFixed(2),
              to: +to.toFixed(2),
              ease: fitEase(samples).name,
            });
          }
        }
        i = j + 1;
      }
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

const md = [];
const P = (s) => {
  md.push(s);
  console.log(s);
};

// ================= reveal stages from overlay text =================
const reveal = load(`${PACK}/reveal-track.json`);
if (reveal) {
  P(
    `\n## REVEAL (tap -> card) — ${reveal.frames.length} rAF frames over ${Math.round(reveal.frames.at(-1).t)}ms`,
  );
  let last = '';
  const stages = [];
  for (const fr of reveal.frames) {
    const txt = (fr.txt || '').toUpperCase();
    let stage = null;
    if (/TAP TO SELECT/.test(txt)) stage = 'packs';
    else if (/TAP TO REVEAL/.test(txt)) stage = 'slab';
    else if (/PULL\b/.test(txt) && /•|!/.test(txt)) stage = 'pull';
    else if (/CATEGORY|GRADE|YEAR/.test(txt)) stage = 'metadata';
    else if (/CONTINUE|OPEN ANOTHER|SELL/.test(txt)) stage = 'card';
    if (stage && stage !== last) {
      stages.push({
        t: Math.round(fr.t),
        stage,
        txt: (fr.txt || '').slice(0, 70),
      });
      last = stage;
    }
  }
  P('### Stage timeline (ms from tap):');
  stages.forEach((s) =>
    P(`- ${String(s.t).padStart(6)}  ${s.stage.padEnd(9)} "${s.txt}"`),
  );
  P('### Motion segments:');
  segments(reveal).forEach((s) =>
    P(
      `- t=${String(s.t0).padStart(6)} +${String(s.dur).padStart(4)}ms  ${s.prop.padEnd(4)} ${String(s.from).padStart(8)} -> ${String(s.to).padEnd(8)} ${s.ease.padEnd(28)} ${s.sig}`,
    ),
  );
  const anims = new Set();
  reveal.frames.forEach((fr) =>
    fr.n.forEach((n) => n.an && anims.add(`${n.an}  [${n.s.slice(0, 50)}]`)),
  );
  if (anims.size) {
    P('### CSS animations seen:');
    [...anims].slice(0, 20).forEach((a) => P('- ' + a));
  }
}

// ================= cylinder =================
for (const name of [
  'overlay-entrance',
  'cylinder-idle',
  'cylinder-drag',
  'cylinder-shuffle',
]) {
  const d = load(`${PACK}/${name}.json`);
  if (!d || !d.frames?.length) continue;
  P(
    `\n## ${name} — ${d.frames.length} frames over ${Math.round(d.frames.at(-1).t)}ms`,
  );
  if (name.startsWith('cylinder')) {
    const series = d.frames
      .map((fr) => ({ t: fr.t, n: fr.n[0] }))
      .filter((r) => r.n);
    const rots = series.map((r) => ({ t: r.t, ...parseT(r.n.tr) }));
    const ys = rots.filter((r) => r.rotY != null);
    if (ys.length) {
      const first = ys[0],
        lastr = ys[ys.length - 1];
      const min = Math.min(...ys.map((r) => r.rotY)),
        max = Math.max(...ys.map((r) => r.rotY));
      P(
        `- rotY: first ${first.rotY}° last ${lastr.rotY}°  range [${min}°, ${max}°]`,
      );
      // velocity profile: print every ~10th sample compactly
      const compact = ys
        .filter((_, i) => i % Math.ceil(ys.length / 26) === 0)
        .map((r) => `${Math.round(r.t)}:${r.rotY.toFixed(1)}`)
        .join(' ');
      P(`- rotY(t): ${compact}`);
    }
    const sample = series[0]?.n;
    if (sample) P(`- node: ${sample.s ?? ''} ${series[0].n.tr?.slice(0, 60)}`);
  } else {
    segments(d)
      .slice(0, 24)
      .forEach((s) =>
        P(
          `- t=${String(s.t0).padStart(5)} +${String(s.dur).padStart(4)}ms ${s.prop.padEnd(4)} ${s.from} -> ${s.to}  ${s.ease.padEnd(26)} ${s.sig}`,
        ),
      );
  }
}

// ================= hero =================
const hero = load(`${PAGE}/hero-curve.json`);
if (hero) {
  P(
    `\n## HERO — ${hero.frames.length} frames over ${Math.round(hero.frames.at(-1).t)}ms`,
  );
  segments(hero).forEach((s) =>
    P(
      `- t=${String(s.t0).padStart(6)} +${String(s.dur).padStart(4)}ms ${s.prop.padEnd(4)} ${String(s.from).padStart(8)} -> ${String(s.to).padEnd(8)} ${s.ease.padEnd(28)} ${s.sig}`,
    ),
  );
}

// ================= entry =================
const entry = load(`${PAGE}/entry-curve.json`);
if (entry) {
  P(`\n## SCROLL-ENTRY`);
  if (!entry.frames?.length)
    P('- no frames captured: ' + JSON.stringify(entry).slice(0, 200));
  else {
    P(`- candidate: ${JSON.stringify(entry.candidate || {}).slice(0, 220)}`);
    const segs = segments(entry);
    if (!segs.length)
      P(
        '- NO motion segments — the element did not animate on scroll-in (live likely has no entry reveal here)',
      );
    segs.forEach((s) =>
      P(
        `- t=${String(s.t0).padStart(5)} +${String(s.dur).padStart(4)}ms ${s.prop.padEnd(4)} ${s.from} -> ${s.to}  ${s.ease.padEnd(26)} ${s.sig}`,
      ),
    );
  }
}

// ================= hovers + catalog (verbatim, they're small) =================
for (const [file, label] of [
  ['home-hover.json', 'HOME CARD HOVER'],
  ['claw-hover.json', 'CLAW CARD HOVER'],
]) {
  const d = load(`${PAGE}/${file}`);
  if (!d) continue;
  P(`\n## ${label}`);
  const diff = (b, a, who) => {
    for (const k of Object.keys(b)) {
      const bv = JSON.stringify(b[k]),
        av = JSON.stringify(a[k]);
      if (bv !== av && k !== 'transition') P(`- ${who}.${k}: ${bv} -> ${av}`);
    }
    if (b.transition) P(`- ${who}.transition: ${b.transition}`);
  };
  diff(d.before.self, d.after.self, 'self');
  d.before.kids.forEach((bk, i) => {
    const ak = d.after.kids[i];
    if (ak) diff(bk, ak, `kid${i}(${bk.tag}.${(bk.cls || '').slice(0, 18)})`);
  });
}
const cat = load(`${PAGE}/claw-catalog.json`);
if (cat) {
  P(`\n## CLAW CATALOG ROWS`);
  cat.rows.forEach((r, i) =>
    P(
      `- row${i}: overflowX=${r.overflowX} snap="${r.scrollSnapType}" childSnap=${r.childSnapAlign} gap=${r.gap} cursor=${r.cursor} childW=${r.childW} kids=${r.kids} arrows=[${r.arrows}] cls="${r.cls.slice(0, 50)}"`,
    ),
  );
}

fs.writeFileSync(`${PACK}/DIGEST.md`, md.join('\n'));
console.log(`\nWROTE ${PACK}/DIGEST.md`);
