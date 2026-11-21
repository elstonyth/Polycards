// The owner's window (2500x1288 at device ratio 1.5): every focus stop keeps the focused pack in 3D, with
// nothing dropped and reloaded while it rests, and the printed back turns at "Pull odds" and "buyback".
// At 71ea7f2f7 the stops ran a 3-frame drop/reload loop here (the pack flickered and never turned).
// Usage: node scripts/qa-home-wide-focus.mjs [--base=http://127.0.0.1:PORT]
import { launch, stage, check, done, deadline } from './lib/qa-kit.mjs';
import { missing } from './lib/qa-present.mjs';

deadline(150000);
const b = await launch();
try {
  const s = await stage.open(b, 'desktop', '/home-preview', {
    context: {
      viewport: { width: 2500, height: 1288 },
      deviceScaleFactor: 1.5,
    },
  });
  await s.page.mouse.move(1250, 644);
  for (let i = 1; i <= 6; i++) {
    await s.page.mouse.wheel(0, 120);
    const r = await stage.rest(s, 6000);
    // the stop's block names it; with none found, no stop would ask the back to turn
    const noBlock = await missing(
      s.page,
      '[data-testid="focus-stops"] section[data-on]',
    );
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
      'stop-' + i + '-' + r.block + '-steady-3d',
      !noBlock &&
        r.on &&
        f.loads === 0 &&
        f.disposals === 0 &&
        f.blank === 0 &&
        (!turns || f.back === 'ready'),
      (noBlock ? noBlock + '; ' : '') + JSON.stringify(f),
    );
  }
} finally {
  await b.close();
}
await done();
