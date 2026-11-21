// qa-home-flick.mjs: a finger flick in the free part of /home-preview (phone).
// Replaces the old "flick-across-last-wraps-once" check, which released in the
// same task as the last move and so never saw a frame between them.
//   Claim 1: three 32 px moves about 16 ms apart and the lift right behind
//            them, all sent under a 400 ms long task (several times the
//            gesture, so the two clocks differ) and handled in a burst:
//            the glide matches the finger's speed by the touch events' own
//            times, and is far from what the times they were handled at
//            would give (the sample is invalid unless the two differ).
//   Claim 2: started close above Last's top, the glide crosses it and the page
//            wraps once, ending at the row.
//   Claim 3: a finger held still 200 ms before lifting does not glide.
// Claims 2 and 3: CDP touch moves awaited one by one arrive every 62 to 94 ms
// in headless Chrome, so each flick is three moves of 150 px (about 27 to 40
// px per 60 Hz frame).
// Run from a worktree root, through the queue (timing: exclusive):
//   node <tools>/qa-with-lock.mjs --exclusive --runner=<lane> -- node scripts/qa-home-flick.mjs --base=URL
import * as qa from './lib/qa-kit.mjs';

const { stage, check, info } = qa;
qa.deadline(170000);
const FRAME_MS = 1000 / 60;
const POWER = 1.7;
const HOLD_MS = 100;
const BURST_MS = 4;
const MOVES = 3;
const BURST_MOVES = 3;
const BURST_STEP = 32;
const BURST_GAP_MS = 16;
const LONG_TASK_MS = 400;
/** The event clock fits when an event's time is at most this ahead of its handling (the gate's slack). */
const CLOCK_SLACK_MS = 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
 * Claim 1's flick: the touchstart, then a 400 ms long task on the page; under
 * it three 32 px moves about 16 ms apart and the lift right behind the last,
 * sent without waiting for the page (it is busy), so it handles them in a
 * burst. The task outlasts the gesture several times over: a gesture as long
 * as the task reads the same speed on both clocks.
 */
async function burstFlick(s) {
  await send(s, 'touchStart', [[X, Y0]]);
  const busy = s.page.evaluate((ms) => {
    const t = performance.now();
    while (performance.now() - t < ms);
  }, LONG_TASK_MS);
  await wait(5);
  const sent = [];
  for (let i = 1; i <= BURST_MOVES; i++) {
    if (i > 1) await wait(BURST_GAP_MS);
    sent.push(send(s, 'touchMove', [[X, Y0 - BURST_STEP * i]]));
  }
  sent.push(send(s, 'touchEnd', []));
  await Promise.all([busy, ...sent]);
}

/**
 * The glide the pager's rule gives on one clock of the log (`col` 0: the
 * touch events' own times; 1: when the page handled them). Mirrors
 * releaseSpeed() and glideDistance() in
 * src/components/pack-stage/stage-flow-pager.ts: keep the two in step. None
 * when the last move was made more than 100 ms before the lift; else first
 * to last over the moves within 100 ms of the last one (the last two when
 * they are sparser); moves spanning under 4 ms (a burst) are measured from
 * the newest move at least 4 ms before the last (none: no glide). `late`:
 * how long after its own time the lift was handled.
 */
function expected(log, col = 0) {
  const m = log.moves;
  const at = log.end[col];
  const late = log.end[1] - log.end[0];
  const b = m.at(-1);
  const gap = b ? at - b[col] : null;
  const recent = b ? m.filter((s) => b[col] - s[col] <= HOLD_MS) : [];
  let a = recent.length >= 2 ? recent[0] : m.at(-2);
  if (a && b && b[col] - a[col] < BURST_MS)
    a = m.slice(0, -1).findLast((s) => b[col] - s[col] >= BURST_MS);
  if (!a || !b || gap > HOLD_MS)
    return { glide: 0, gap, span: null, v: null, late, n: recent.length };
  const span = b[col] - a[col];
  const v = ((b[2] - a[2]) * FRAME_MS) / span;
  const glide = Math.sign(v) * Math.abs(v) ** POWER;
  return { glide, gap, span, v, late, n: recent.length };
}
/** The flick check's tolerance around an expected glide. */
const tolerance = (glide) => 0.15 * Math.abs(glide) + 4;
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

    // Claim 1: moves handled in a burst glide by the events' own times
    const mid = Math.round(t.exitEnd + 200);
    await place(mid);
    await arm(s);
    await burstFlick(s);
    await s.settle({ quiet: 400, timeout: 6000 });
    let log = await read(s);
    let e = expected(log);
    const h = expected(log, 1);
    let end = await s.page.evaluate(() => scrollY);
    let glide = end - log.end[2];
    await s.capture('burst flick from ' + mid + ': glide ' + Math.round(glide));
    const tol = tolerance(e.glide);
    // the page falls back to its handling clock for event times that do not
    // fit it; the sample counts only when the two clocks ask different glides
    const clockFits =
      log.end[0] > 0 && log.end[0] <= log.end[1] + CLOCK_SLACK_MS;
    const valid1 =
      clockFits &&
      e.gap !== null &&
      e.gap < HOLD_MS &&
      e.glide > 100 &&
      Math.abs(e.glide - h.glide) > 2 * tol;
    const times = log.moves
      .map((m) => r1(m[0]) + '/+' + r1(m[1] - m[0]))
      .join(', ');
    check(
      'burst-flick-glides-by-event-times [phone]',
      valid1 &&
        Math.abs(glide - e.glide) <= tol &&
        Math.abs(glide - h.glide) > tol,
      (valid1
        ? ''
        : 'INVALID SAMPLE (the event and handling clocks must ask glides more than ' +
          r1(2 * tol) +
          ' px apart, the lift under 100 ms after the last move, an event clock that fits); ') +
        'glide ' +
        r1(glide) +
        ' px; by event times ' +
        r1(e.glide) +
        ' (' +
        e.n +
        ' events in the last 100 ms spanning ' +
        r1(e.span) +
        ' ms, ' +
        r1(e.v) +
        ' px per 60 Hz frame, lift ' +
        r1(e.gap) +
        ' ms after the last move), by handling times ' +
        r1(h.glide) +
        ' (spanning ' +
        r1(h.span) +
        ' ms); events made/handled +ms: ' +
        times +
        '; lift ' +
        r1(log.end[0]) +
        '/+' +
        r1(e.late),
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
