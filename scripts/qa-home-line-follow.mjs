// The lineup follows the hand: a sideways drag moves the row as far as the pointer at every size, and the
// glide after a quick swipe never moves the row so far in one frame that the look-alike capsules strobe.
// Per size: the on-screen capsule spacing (the two tiles nearest the middle), a slow drag's row/hand ratio,
// and a quick swipe's largest move per frame, in capsule spacings, held and gliding.
// Before this check the drag was one pack per 100 px on every size (about 3x the hand at 2500 wide).
// Usage: node scripts/qa-home-line-follow.mjs [--base=http://127.0.0.1:PORT] [--only=wide|desktop|phone]
import { launch, stage, check, done, deadline } from './lib/qa-kit.mjs';

deadline(400000);
const SIZES = [
  {
    name: 'wide',
    profile: 'desktop',
    context: {
      viewport: { width: 2500, height: 1288 },
      deviceScaleFactor: 1.5,
    },
  },
  { name: 'desktop', profile: 'desktop', context: {} },
  { name: 'phone', profile: 'phone', context: {} },
];
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
/** Largest row move in one frame (spacings) at which the strobe cannot start: half a spacing reads both ways. */
const MAX_STEP = 0.45;

for (const z of SIZES.filter(
  (z) => !only || only.split(',').includes(z.name),
)) {
  const b = await launch();
  try {
    const s = await stage.open(b, z.profile, '/home-preview', {
      context: z.context,
    });
    const { page } = s;
    const { width: w, height: h } = page.viewportSize();
    await page.getByRole('button', { name: /^Poly$/ }).click();
    await page.waitForFunction(
      () => {
        const f = window.__packStage.flow();
        return f.bound && !f.busy;
      },
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(1500);
    if (!s.cdp) await page.mouse.move(w / 2, h / 2);
    for (let i = 0; i < 12; i++) {
      const r = await stage.snap(s);
      if (r.past) break;
      await s.step(1);
      await stage.rest(s, 6000);
    }
    const tiles = (await stage.tiles(s))
      .filter((t) => t.vis)
      .sort((a, c) => Math.abs(a.x - w / 2) - Math.abs(c.x - w / 2));
    const pitch = tiles.length >= 2 ? Math.abs(tiles[0].x - tiles[1].x) : NaN;
    const y0 = Math.round(h * (z.profile === 'phone' ? 0.45 : 0.5));
    // per animation frame: the line position (packs) and whether it is held
    const record = () =>
      page.evaluate(() => {
        window.__lf = [];
        window.__lfOn = true;
        const tick = () => {
          if (!window.__lfOn) return;
          const l = window.__packStage.flow().line;
          window.__lf.push({ pos: l.pos, moving: l.moving });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const stop = () =>
      page.evaluate(() => {
        window.__lfOn = false;
        return window.__lf;
      });
    const drag = async (dx, moves, dt, hold) => {
      const x0 = w / 2 - dx / 2;
      if (s.cdp) {
        await s.cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: x0, y: y0 }],
        });
        for (let i = 1; i <= moves; i++) {
          await s.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x0 + (dx * i) / moves, y: y0 }],
          });
          await page.waitForTimeout(dt);
        }
        if (hold) await page.waitForTimeout(hold);
        const before = await page.evaluate(
          () => window.__packStage.flow().line.pos,
        );
        await s.cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        return before;
      }
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= moves; i++) {
        await page.mouse.move(x0 + (dx * i) / moves, y0);
        await page.waitForTimeout(dt);
      }
      if (hold) await page.waitForTimeout(hold);
      const before = await page.evaluate(
        () => window.__packStage.flow().line.pos,
      );
      await page.mouse.up();
      return before;
    };
    // slow drag, held still before release: row px moved / hand px moved
    const slowPx = z.profile === 'phone' ? -240 : -400;
    // a short drag first: the line takes the row (its position reads 0 until then); it snaps back
    await drag(z.profile === 'phone' ? -20 : -30, 4, 30, 150);
    await page.waitForTimeout(1200);
    const p0 = await page.evaluate(() => window.__packStage.flow().line.pos);
    await record();
    const held = await drag(slowPx, 30, 30, 250);
    const slow = await stop();
    if (process.env.DEBUG)
      console.log(p0, held, JSON.stringify(slow.map((x) => +x.pos.toFixed(2))));
    const ratio = (Math.abs(held - p0) * pitch) / Math.abs(slowPx);
    await page.waitForTimeout(1500);
    check(
      z.name + '-drag-follows-the-hand',
      ratio > 0.85 && ratio < 1.15,
      JSON.stringify({
        pitch,
        handPx: slowPx,
        rowPacks: +(held - p0).toFixed(3),
        rowPerHand: +ratio.toFixed(2),
      }),
    );
    // quick swipe: 6 moves 16 ms apart, then let go; largest move per frame in spacings
    const quickPx = z.profile === 'phone' ? -360 : -600;
    await record();
    await drag(quickPx, 6, 16, 0);
    await page.waitForTimeout(1800);
    const f = await stop();
    const steps = f.slice(1).map((x, i) => x.pos - f[i].pos);
    const all = Math.max(...steps.map(Math.abs));
    check(
      z.name + '-quick-swipe-no-strobe',
      all <= MAX_STEP,
      JSON.stringify({
        pitch,
        handPx: quickPx,
        maxPerFrame: +all.toFixed(3),
        steps: steps.filter((d) => d !== 0).map((d) => +d.toFixed(2)),
      }),
    );
  } finally {
    await b.close();
  }
}
await done();
