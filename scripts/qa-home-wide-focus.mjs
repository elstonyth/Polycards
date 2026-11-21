// Wide desktop windows: the recorded 2500x1288 window at ratio 1.5 and the four forms of a 4K monitor
// (3840x2160 at 1, 3072x1728 at 1.25, 2560x1440 at 1.5, 1920x1080 at 2). The row draws its packs in 3D;
// every focus stop keeps the focused pack in 3D at the window's full pixel ratio (sharp), with nothing
// dropped and reloaded while it rests, and the printed back turns at "Pull odds" and "buyback".
// At 71ea7f2f7 the stops ran a 3-frame drop/reload loop at 2500x1288 (the pack flickered and never
// turned); under the old 96 MB cap a 4K monitor drew the stops at ratio 0.5.
// Usage: node scripts/qa-home-wide-focus.mjs [--base=http://127.0.0.1:PORT] [--forms=2560x1440@1.5,...]
import { args, launch, stage, check, done, deadline } from './lib/qa-kit.mjs';
import { missing } from './lib/qa-present.mjs';

const FORMS = args
  .flag(
    'forms',
    '2500x1288@1.5,3840x2160@1,3072x1728@1.25,2560x1440@1.5,1920x1080@2',
  )
  .split(',');
deadline(90000 * FORMS.length);
const read = (page) =>
  page.evaluate(() => {
    const r = window.__packStage.runtime();
    return { ratio: r.pixelRatio, drawn: r.drawn.length };
  });
const b = await launch();
try {
  for (const form of FORMS) {
    const [size, ratio] = form.split('@');
    const [w, h] = size.split('x').map(Number);
    const dpr = Number(ratio);
    const s = await stage.open(b, 'desktop', '/home-preview', {
      context: { viewport: { width: w, height: h }, deviceScaleFactor: dpr },
    });
    await s.page.mouse.move(w / 2, h / 2);
    const row = await read(s.page);
    check(form + '-row-3d', row.drawn >= 5, JSON.stringify(row));
    for (let i = 1; i <= 6; i++) {
      await s.page.mouse.wheel(0, 120);
      const r = await stage.rest(s, 6000);
      // the stop's block names it; with none found, no stop would ask the back to turn
      const noBlock = await missing(
        s.page,
        '[data-testid="focus-stops"] section[data-on]',
      );
      const at = await read(s.page);
      // 30 frames at rest: loads, disposals, the 3D pack drawn, the back's state
      const f = await s.page.evaluate(
        () =>
          new Promise((done) => {
            const ps = window.__packStage;
            const a = ps.runtime();
            let n = 0;
            let blank = 0;
            const tick = () => {
              if (ps.runtime().drawn.length === 0) blank++;
              if (++n < 30) return requestAnimationFrame(tick);
              const z = ps.runtime();
              done({
                loads: z.loads - a.loads,
                disposals: z.disposals - a.disposals,
                blank,
                back: z.focusBack?.state ?? null,
              });
            };
            requestAnimationFrame(tick);
          }),
      );
      const turns = r.block === 'odds' || r.block === 'buyback';
      check(
        form + '-stop-' + i + '-' + r.block + '-steady-3d-full-ratio',
        !noBlock &&
          Math.abs(at.ratio - dpr) < 1e-3 &&
          r.on &&
          f.loads === 0 &&
          f.disposals === 0 &&
          f.blank === 0 &&
          (!turns || f.back === 'ready'),
        (noBlock ? noBlock + '; ' : '') +
          JSON.stringify({ ...f, ratio: +at.ratio.toFixed(3) }),
      );
    }
    for (let i = 0; i < 4 && !(await stage.snap(s)).past; i++) {
      await s.page.mouse.wheel(0, 120);
      await stage.rest(s, 6000);
    }
    const line = await read(s.page);
    check(form + '-lineup-3d', line.drawn >= 5, JSON.stringify(line));
    await s.ctx.close();
  }
} finally {
  await b.close();
}
await done();
