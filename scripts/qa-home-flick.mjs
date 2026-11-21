// qa-home-flick.mjs: a finger flick in the free part of /home-preview (phone).
// Replaces the old "flick-across-last-wraps-once" check, which released in the
// same task as the last move and so never saw a frame between them.
//   Claim 1: released one frame after the last move, the page glides on, as
//            far as the finger's speed says: first to last over the moves made
//            in the 100 ms before the lift, timed by the touch events' own
//            times (not when the page handled them).
//   Claim 2: started close above Last's top, the glide crosses it and the page
//            wraps once, ending at the row.
//   Claim 3: a finger held still 200 ms before lifting does not glide.
// CDP touch moves arrive every 62 to 94 ms in headless Chrome, so each flick
// is three moves of 150 px (about 27 to 40 px per 60 Hz frame).
// Run from a worktree root, through the queue (timing: exclusive):
//   node <tools>/qa-with-lock.mjs --exclusive --runner=<lane> -- node scripts/qa-home-flick.mjs --base=URL
import * as qa from './lib/qa-kit.mjs';

const { stage, check, info } = qa;
qa.deadline(170000);
const FRAME_MS = 1000 / 60;
const POWER = 1.7;
const HOLD_MS = 100;
const MOVES = 3;
const STEP = 150;
const X = 200;
const Y0 = 700;

/**
 * Logs the touchstart and each touchmove as [event time, handling time, scroll
 * after the flow's handler], the touchend as [event time, handling time,
 * scroll], and every frame's scroll.
 */
const arm = (s) =>
  s.page.evaluate(() => {
    const w = window;
    w.__fl = { moves: [], end: null, ys: [] };
    if (!w.__flOn) {
      w.__flOn = true;
      const log = (e) => {
        const t = performance.now();
        // the flow writes the follow in its own handler: read it after
        queueMicrotask(() => w.__fl.moves.push([e.timeStamp, t, scrollY]));
      };
      addEventListener('touchstart', log);
      addEventListener('touchmove', log);
      addEventListener('touchend', (e) => {
        w.__fl.end = [e.timeStamp, performance.now(), scrollY];
      });
    }
    const f = () => {
      w.__fl.ys.push(scrollY);
      if (w.__fl.ys.length < 600) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
const read = (s) => s.page.evaluate(() => window.__fl);
const send = (s, type, pts) =>
  s.cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })),
  });

/**
 * Three 150 px moves up; then one frame (or holdMs still) and the release.
 * `liftNow`: the release goes out right behind the last move, without
 * waiting for the page's reply to it (that reply takes 60 to 100 ms in
 * headless Chrome, which by the events' own times is a finger held still).
 */
async function flick(s, holdMs = 0, liftNow = false) {
  await send(s, 'touchStart', [[X, Y0]]);
  for (let i = 1; i < MOVES; i++)
    await send(s, 'touchMove', [[X, Y0 - STEP * i]]);
  const last = send(s, 'touchMove', [[X, Y0 - STEP * MOVES]]);
  if (liftNow) {
    await Promise.all([last, send(s, 'touchEnd', [])]);
    return;
  }
  await last;
  if (holdMs) await s.page.waitForTimeout(holdMs);
  else await s.frames(1);
  await send(s, 'touchEnd', []);
}

/**
 * The glide the finger asked for, from the touch events' own times: none when
 * the last move was made more than 100 ms before the lift; else first to last
 * over the moves within 100 ms of the last one (the last two when they are
 * sparser). `late`: how long after its own time the lift was handled.
 */
function expected(log) {
  const m = log.moves;
  const at = log.end[0];
  const late = log.end[1] - at;
  const b = m.at(-1);
  const gap = b ? at - b[0] : null;
  const recent = b ? m.filter((s) => b[0] - s[0] <= HOLD_MS) : [];
  const a = recent.length >= 2 ? recent[0] : m.at(-2);
  if (!a || !b || b[0] <= a[0] || gap > HOLD_MS)
    return { glide: 0, gap, span: null, v: null, late, n: recent.length };
  const span = b[0] - a[0];
  const v = ((b[2] - a[2]) * FRAME_MS) / span;
  const glide = Math.sign(v) * Math.abs(v) ** POWER;
  return { glide, gap, span, v, late, n: recent.length };
}
const r1 = (n) => (n === null ? 'null' : Math.round(n * 10) / 10);

const browser = await qa.launch();
try {
  const size = 'phone';
  const s = await stage.open(browser, size, '/home-preview');
  try {
    const t = await s.page.evaluate(() => window.__packStage.flow().table);
    info(
      'table [phone]',
      'exitEnd ' +
        r1(t.exitEnd) +
        ', lastTop ' +
        r1(t.lastTop) +
        ', r0 ' +
        r1(t.r0),
    );
    // set-up only (not the gesture under test): the page put in the free part
    const place = async (y) => {
      await s.page.evaluate((v) => window.scrollTo(0, v), y);
      await s.page.waitForTimeout(600);
    };

    // Claim 1: a glide after one frame between the last move and the release
    const mid = Math.round(t.exitEnd + 200);
    await place(mid);
    await arm(s);
    await flick(s);
    await s.settle({ quiet: 400, timeout: 6000 });
    let log = await read(s);
    let e = expected(log);
    let end = await s.page.evaluate(() => scrollY);
    let glide = end - log.end[2];
    await s.capture('flick from ' + mid + ': glide ' + Math.round(glide));
    // the page falls back to its handling clock for event times that do not fit it
    const valid1 =
      e.gap !== null && e.gap < HOLD_MS && e.late >= -1 && e.late < 1000;
    check(
      'flick-glides-after-a-frame [phone]',
      valid1 &&
        e.glide > 100 &&
        Math.abs(glide - e.glide) <= 0.15 * e.glide + 4,
      (valid1
        ? ''
        : 'INVALID SAMPLE (release ' +
          r1(e.gap) +
          ' ms after the last move, handled ' +
          r1(e.late) +
          ' ms after it was made); ') +
        log.moves.length +
        ' touch events, ' +
        e.n +
        ' in the last 100 ms spanning ' +
        r1(e.span) +
        ' ms by their own times (' +
        r1(e.v) +
        ' px per 60 Hz frame); release ' +
        r1(e.gap) +
        ' ms after the last move, handled ' +
        r1(e.late) +
        ' ms after it was made; glide ' +
        r1(glide) +
        ' px, the finger asked for ' +
        r1(e.glide),
    );

    // Claim 2: close above Last's top, the glide crosses it: one wrap, to the row
    const near = Math.round(t.lastTop - (MOVES * STEP + 100));
    await place(near);
    await arm(s);
    await flick(s, 0, true);
    await s.page.waitForTimeout(400);
    await s.capture('flick across Last: 400 ms after the release');
    await s.settle({ quiet: 500, timeout: 6000 });
    log = await read(s);
    e = expected(log);
    end = await s.page.evaluate(() => scrollY);
    let wraps = 0;
    for (let i = 1; i < log.ys.length; i++)
      if (log.ys[i - 1] - log.ys[i] > 1000) wraps++;
    await s.capture('flick across Last: rests at ' + Math.round(end));
    info(
      'touch times [phone]',
      log.moves
        .map((s) => 'made ' + r1(s[0]) + ' handled +' + r1(s[1] - s[0]))
        .join(', ') +
        '; lift made ' +
        r1(log.end[0]) +
        ' handled +' +
        r1(e.late),
    );
    const valid2 = e.gap < HOLD_MS;
    check(
      'flick-across-last-wraps-once [phone]',
      valid2 &&
        log.end[2] < t.lastTop &&
        wraps === 1 &&
        Math.abs(end - t.r0) < 1,
      (valid2
        ? ''
        : 'INVALID SAMPLE (release ' +
          r1(e.gap) +
          ' ms after the last move); ') +
        'from ' +
        near +
        ', released at ' +
        r1(log.end[2]) +
        ' (Last top ' +
        r1(t.lastTop) +
        ', ' +
        r1(e.gap) +
        ' ms after the last move, asked glide ' +
        r1(e.glide) +
        '); ' +
        wraps +
        ' wrap(s); rests at ' +
        r1(end) +
        ' (row ' +
        r1(t.r0) +
        ')',
    );

    // Claim 3: held still 200 ms, then lifted: no glide
    await place(mid);
    await arm(s);
    await flick(s, 200);
    await s.settle({ quiet: 400, timeout: 6000 });
    log = await read(s);
    e = expected(log);
    end = await s.page.evaluate(() => scrollY);
    glide = end - log.end[2];
    await s.capture('hold 200 ms then lift: glide ' + Math.round(glide));
    check(
      'hold-then-lift-no-glide [phone]',
      e.gap > HOLD_MS && Math.abs(glide) < 1 && log.end[2] > mid + 100,
      'released ' +
        r1(e.gap) +
        ' ms after the last move at ' +
        r1(log.end[2]) +
        ' (from ' +
        mid +
        '); then ' +
        r1(glide) +
        ' px',
    );

    s.checkNoErrors();
  } finally {
    await s.ctx.close();
  }
  await qa.sheet();
} catch (err) {
  check(
    'script',
    false,
    String(err?.stack ?? err)
      .split('\n')
      .slice(0, 2)
      .join(' '),
  );
} finally {
  await qa.done();
}
