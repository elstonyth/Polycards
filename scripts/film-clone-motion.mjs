// Film the CLONE's motion (prod :4000) with the same rAF recorder used on live
// (recon-motion-live{,2}.mjs) and print a digest to compare against
// docs/research/components/motion-fidelity.spec.md.
//  Phase 1: hero carousel curve (~9s)
//  Phase 2: /claw/pokemon-mythic demo reveal — idle float, tap -> packs exit ->
//           slab rise -> (tap) metadata -> auto -> [pull] -> card.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const OUT = 'docs/research/clone-film/v2';
fs.mkdirSync(OUT, { recursive: true });
const save = (n, x) => {
  fs.writeFileSync(`${OUT}/${n}`, JSON.stringify(x));
  console.log('WROTE', `${OUT}/${n}`, x?.frames?.length ?? '');
};

// ---------- shared easing fit ----------
function cubicBez(x1, y1, x2, y2) {
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
  ease: cubicBez(0.25, 0.1, 0.25, 1),
  'ease-in': cubicBez(0.42, 0, 1, 1),
  'ease-out': cubicBez(0, 0, 0.58, 1),
  'ease-in-out': cubicBez(0.42, 0, 0.58, 1),
  'tw(0.4,0,0.2,1)': cubicBez(0.4, 0, 0.2, 1),
  outCubic: cubicBez(0.22, 0.61, 0.36, 1),
  'outQuint(0.16,1,0.3,1)': cubicBez(0.16, 1, 0.3, 1),
  'outBack(0.34,1.56,0.64,1)': cubicBez(0.34, 1.56, 0.64, 1),
  'exit(0.55,0,0.85,0.4)': cubicBez(0.55, 0, 0.85, 0.4),
};
const fitEase = (samples) => {
  let best = null;
  for (const [name, fn] of Object.entries(BEZ)) {
    const err =
      samples.reduce((a, s) => a + (fn(s.p) - s.v) ** 2, 0) /
      (samples.length || 1);
    if (!best || err < best.err) best = { name, err };
  }
  if (Math.max(...samples.map((s) => s.v), 0) > 1.04)
    best.name = `spring/overshoot(+${(Math.max(...samples.map((s) => s.v)) * 100 - 100).toFixed(0)}%)`;
  return best.name;
};
const dec = (tr) => {
  if (!tr || tr === 'none') return {};
  const m = tr.match(/-?[\d.e]+/g)?.map(Number) || [];
  if (tr.startsWith('matrix3d'))
    return {
      sc: +Math.hypot(m[0], m[1], m[2]).toFixed(4),
      rotY: +((Math.atan2(m[8], m[0]) * 180) / Math.PI).toFixed(2),
      tx: +m[12].toFixed(1),
      ty: +m[13].toFixed(1),
    };
  if (tr.startsWith('matrix'))
    return {
      sc: +Math.hypot(m[0], m[1]).toFixed(4),
      rot: +((Math.atan2(m[1], m[0]) * 180) / Math.PI).toFixed(2),
      tx: +m[4].toFixed(1),
      ty: +m[5].toFixed(1),
    };
  return {};
};
function printSegments(track, label) {
  console.log(`\n### ${label} segments:`);
  const bySig = new Map();
  for (const fr of track.frames)
    for (const n of fr.n || []) {
      (bySig.get(n.s) || bySig.set(n.s, []).get(n.s)).push({
        t: fr.t,
        o: n.o,
        ...dec(n.tr),
      });
    }
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
          to = seg.at(-1).v;
        if (Math.abs(to - from) >= (prop === 'o' ? 0.08 : 3)) {
          const t0 = seg[0].t,
            dur = seg.at(-1).t - t0;
          if (dur > 30 && dur < 5000) {
            const span = to - from || 1;
            rows.push({
              t0,
              dur,
              prop,
              from,
              to,
              ease: fitEase(
                seg.map((s) => ({
                  p: (s.t - t0) / (dur || 1),
                  v: (s.v - from) / span,
                })),
              ),
              sig,
            });
          }
        }
        i = j + 1;
      }
    }
  }
  rows
    .sort((a, b) => a.t0 - b.t0)
    .forEach((s) =>
      console.log(
        `- t=${String(Math.round(s.t0)).padStart(6)} +${String(Math.round(s.dur)).padStart(4)}ms ${s.prop.padEnd(4)} ${String(+s.from.toFixed(2)).padStart(8)} -> ${String(+s.to.toFixed(2)).padEnd(8)} ${s.ease.padEnd(26)} ${s.sig.slice(0, 56)}`,
      ),
    );
  return rows;
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});

// ---------------- Phase 1: HERO ----------------
await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const data = { t0: performance.now(), frames: [], stopped: false };
  window.__hero = data;
  const tick = () => {
    if (data.stopped) return;
    const t = +(performance.now() - data.t0).toFixed(1);
    const imgs = [...document.querySelectorAll('img')]
      .filter((im) => {
        const r = im.getBoundingClientRect();
        return (
          r.top < 560 &&
          r.bottom > 40 &&
          r.x > 560 &&
          r.width > 50 &&
          r.height > 50
        );
      })
      .map((im) => {
        let wrap = im.parentElement,
          wcs = getComputedStyle(wrap),
          d = 0;
        while (
          wrap &&
          d < 4 &&
          wcs.transform === 'none' &&
          wcs.opacity === '1'
        ) {
          wrap = wrap.parentElement;
          wcs = getComputedStyle(wrap);
          d++;
        }
        const r = im.getBoundingClientRect();
        return {
          src: (im.currentSrc || im.src || '').split('/').pop().split('?')[0],
          cx: Math.round(r.x + r.width / 2),
          wo: +(+wcs.opacity).toFixed(3),
          wt: wcs.transform === 'none' ? '' : wcs.transform,
        };
      });
    data.frames.push({ t, imgs });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(9500);
const hero = await page.evaluate(() => {
  const d = window.__hero;
  d.stopped = true;
  return { frames: d.frames };
});
save('hero-curve.json', hero);
// hero digest: per-theme cx windows
{
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
      const sc = dec(ims[0].wt).sc ?? 1;
      (themes.get(t) || themes.set(t, []).get(t)).push({ t: fr.t, cx, wo, sc });
    }
  }
  console.log('\n### CLONE HERO transitions:');
  for (const [name, series] of themes) {
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
        console.log(
          `- ${name}: t=${Math.round(from.t)} +${Math.round(to.t - from.t)}ms cx ${from.cx}->${to.cx} wo ${from.wo}->${to.wo} sc ${from.sc}->${to.sc} ${ease}`,
        );
      }
      i = j + 1;
    }
  }
}

// ---------------- Phase 2: REVEAL ----------------
await page.goto(`${BASE}/claw/pokemon-mythic`, {
  waitUntil: 'networkidle',
  timeout: 60000,
});
await page.waitForTimeout(800);
await page.getByRole('button', { name: /Try a free demo spin/i }).click();
await page.waitForTimeout(400);

// overlay rAF recorder (same as live runs)
await page.evaluate(() => {
  const sig = (el) => {
    if (el.__sig) return el.__sig;
    const img = el.tagName === 'IMG' ? el : el.querySelector?.(':scope img');
    const src =
      (img?.currentSrc || img?.src || '')
        .split('/')
        .pop()
        ?.split('?')[0]
        ?.slice(-26) || '';
    el.__sig = `${el.tagName}.${('' + (el.className || '')).trim().split(/\s+/).slice(0, 3).join('.').slice(0, 44)}${src ? '#' + src : ''}`;
    return el.__sig;
  };
  const findOverlay = () =>
    [...document.querySelectorAll('div')].find((d) => {
      const s = getComputedStyle(d);
      return (
        s.position === 'fixed' &&
        d.getBoundingClientRect().width > innerWidth * 0.8 &&
        d.querySelector('img,button')
      );
    });
  const data = { t0: performance.now(), frames: [], stopped: false };
  window.__rev = data;
  const tick = () => {
    if (data.stopped) return;
    const t = +(performance.now() - data.t0).toFixed(1);
    const o = findOverlay();
    const fr = { t, n: [] };
    if (o) {
      fr.txt = (o.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const els = [...o.querySelectorAll('*')]
        .filter((el) => {
          if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) return false;
          const cs = getComputedStyle(el);
          return (
            cs.transform !== 'none' ||
            +cs.opacity < 1 ||
            cs.animationName !== 'none'
          );
        })
        .slice(0, 36);
      for (const el of els) {
        try {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          fr.n.push({
            s: sig(el),
            tr: cs.transform,
            o: +(+cs.opacity).toFixed(3),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        } catch {}
      }
    }
    data.frames.push(fr);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// idle float window (2.2s), then tap a pack -> slab (filmed), then tap -> metadata
// -> AUTO advance through [pull] -> card (filmed to the end).
await page.waitForTimeout(2200);
await page.mouse.click(720, 450); // select pack: packs exit + slab rises
await page.waitForTimeout(2300);
await page.screenshot({ path: `${OUT}/slab.png` }).catch(() => {});
await page.mouse.click(720, 450); // slab -> metadata
for (let i = 0; i < 22; i++) {
  await page
    .screenshot({ path: `${OUT}/r-${String(i).padStart(2, '0')}.png` })
    .catch(() => {});
  await page.waitForTimeout(330);
}
const rev = await page.evaluate(() => {
  const d = window.__rev;
  d.stopped = true;
  return { frames: d.frames };
});
save('reveal-track.json', rev);

// stage timeline from overlay text
{
  let last = '';
  console.log('\n### CLONE REVEAL stage timeline:');
  for (const fr of rev.frames) {
    const txt = (fr.txt || '').toUpperCase();
    let stage = null;
    if (/TAP A PACK|DRAG TO SPIN|SHUFFLE/.test(txt)) stage = 'packs';
    else if (/TAP TO REVEAL/.test(txt)) stage = 'slab';
    else if (/PULL •/.test(txt)) stage = 'pull';
    else if (/OPEN ANOTHER/.test(txt)) stage = 'card';
    else if (/CATEGORY|GRADE|YEAR|VALUE/.test(txt)) stage = 'metadata';
    if (stage && stage !== last) {
      console.log(
        `- STAGE ${String(Math.round(fr.t)).padStart(6)}ms  ${stage.padEnd(9)} "${(fr.txt || '').slice(0, 80)}"`,
      );
      last = stage;
    }
  }
}
printSegments(rev, 'CLONE REVEAL');
await page.screenshot({ path: `${OUT}/final.png` }).catch(() => {});
await browser.close();
console.log('DONE');
