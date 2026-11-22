// The lineup follows the hand: a sideways drag moves the row as far as the pointer at every size, and the
// glide after a quick swipe never moves the row so far in one frame that the look-alike capsules strobe
// (while held the row is the hand's, one pointer move a frame).
// Per size: the capsule spacing as drawn (the 3D row's packs either side of the centre, projected to CSS px),
// a slow drag's row/hand ratio (how far the centred capsule is drawn moving against the pointer), and a quick
// swipe's largest move per frame, in capsule spacings, held and gliding. The row's flat tiles keep the row's
// step, not the lineup's drawn spacing, so they are not read here (at 3840 wide they differ by 1.3x).
// Before this check the drag was one pack per 100 px on every size (about 3x the hand at 2500 wide).
// Usage: node scripts/qa-home-line-follow.mjs [--base=http://127.0.0.1:PORT] [--only=wide|k4|desktop|phone]
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
  {
    name: 'k4',
    profile: 'desktop',
    context: { viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1 },
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
    // the 3D row as drawn: world x of each pack, in CSS px (camera fov 28 at distance 10, fitted to the host)
    const drawn = () =>
      page.evaluate(() => {
        const host = document.querySelector('canvas')?.parentElement;
        const hostH = host?.getBoundingClientRect().height || innerHeight;
        const k = (2 * 10 * Math.tan((14 * Math.PI) / 180)) / hostH;
        return window.__packStage
          .runtime()
          .drawn.map((d) => ({ id: d.id, px: d.x / k }));
      });
    const at = await drawn();
    const c0 = at.reduce((a, c) => (Math.abs(c.px) < Math.abs(a.px) ? c : a));
    const side = (sign) =>
      Math.min(
        ...at
          .map((d) => (d.px - c0.px) * sign)
          .filter((v) => v > 1)
          .concat(Infinity),
      );
    const pitch = (side(1) + side(-1)) / 2;
    const y0 = Math.round(h * (z.profile === 'phone' ? 0.45 : 0.5));
    // per animation frame: the line position (packs) and whether it is held
    const record = () =>
      page.evaluate(() => {
        window.__lf = [];
        window.__lfOn = true;
        // held from the first move until the script lets go (the debug line state does not carry it)
        window.__lfHeld = true;
        const tick = () => {
          if (!window.__lfOn) return;
          const l = window.__packStage.flow().line;
          window.__lf.push({ pos: l.pos, held: window.__lfHeld });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const stop = () =>
      page.evaluate(() => {
        window.__lfOn = false;
        return window.__lf;
      });
    const drag = async (dx, moves, dt, hold, whileHeld) => {
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
        if (whileHeld) await whileHeld();
        const before = await page.evaluate(() => {
          window.__lfHeld = false;
          return window.__packStage.flow().line.pos;
        });
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
      if (whileHeld) await whileHeld();
      const before = await page.evaluate(() => {
        window.__lfHeld = false;
        return window.__packStage.flow().line.pos;
      });
      await page.mouse.up();
      return before;
    };
    // slow drag, held still before release: row px moved / hand px moved
    const slowPx = z.profile === 'phone' ? -240 : -400;
    // a short drag first: the line takes the row (its position reads 0 until then); it snaps back
    await drag(z.profile === 'phone' ? -20 : -30, 4, 30, 150);
    await page.waitForTimeout(1200);
    const p0 = await page.evaluate(() => window.__packStage.flow().line.pos);
    const before = await drawn();
    const mark = before.reduce((a, c) =>
      Math.abs(c.px) < Math.abs(a.px) ? c : a,
    );
    await record();
    let heldPx = NaN;
    const held = await drag(slowPx, 30, 30, 250, async () => {
      heldPx = (await drawn()).find((d) => d.id === mark.id)?.px ?? NaN;
    });
    const slow = await stop();
    if (process.env.DEBUG)
      console.log(p0, held, JSON.stringify(slow.map((x) => +x.pos.toFixed(2))));
    // the centred capsule's drawn travel against the hand's
    const ratio = Math.abs(heldPx - mark.px) / Math.abs(slowPx);
    await page.waitForTimeout(1500);
    check(
      z.name + '-drag-follows-the-hand',
      ratio > 0.85 && ratio < 1.15,
      JSON.stringify({
        pitch,
        handPx: slowPx,
        rowPacks: +(held - p0).toFixed(3),
        rowPx: Math.round(Math.abs(heldPx - mark.px)),
        rowPerHand: +ratio.toFixed(2),
      }),
    );
    // quick swipe: 6 moves 16 ms apart, then let go; largest move per frame in spacings
    const quickPx = z.profile === 'phone' ? -360 : -600;
    await record();
    await drag(quickPx, 6, 16, 0);
    await page.waitForTimeout(1800);
    const f = await stop();
    // held, the row moves with the hand (one pointer move a frame); the glide after the release is
    // the line's own motion, and that is what may never move the look-alike capsules near half a spacing
    const steps = f
      .slice(1)
      .map((x, i) => (x.held || f[i].held ? 0 : x.pos - f[i].pos));
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
