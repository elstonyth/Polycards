// qa-home-flick.mjs: a finger flick in the free part of /home-preview (phone).
// Replaces the old "flick-across-last-wraps-once" check, which released in the
// same task as the last move and so never saw a frame between them.
//   Claim 1: from the footer's rest, three 32 px moves down the screen
//            about 24 ms apart and the lift right behind them (the page
//            glides back up into Just Pulled; going down a swipe there pages
//            on to the single pack, so the glide is read going up), all sent
//            under a 400 ms long task (several times the gesture, so the two
//            clocks differ) and handled in a burst:
//            the glide matches the finger's speed by the touch events' own
//            times, and is far from what the times they were handled at
//            would give (the sample is invalid unless the two differ).
//   Claim 2: a long fast flick at the single pack (the end's rest past the
//            footer) is one move to the row back: the page wraps once and
//            rests at the row, never paging on past it.
//   Claim 3: a finger held still 200 ms before lifting does not glide.
//   Claim 4: a long fast flick in Just Pulled does not stop at the footer's
//            rest: it is one move on to the single pack, which it never
//            passes (no wrap).
//   Claim 5: a swipe that starts on the Just Pulled rest (reached by
//            gestures) goes on to the single pack, at the finger's speed
//            across the lift and with no still frame.
//   Claim 6: a swipe from that rest that turns back before the lift settles
//            back on the rest.
//   Claim 7: a touch cancelled between the footer and the single pack leaves
//            the page on one of those rests.
//   Claim 8: at 360x640 (Just Pulled taller than the view) the first swipe
//            from its rest is one move to the footer's rest, the next one on
//            to the single pack.
// The free part ends at the footer's rest (a short span on a phone), so the
// flicks in it start just past the lineup's exit, and the expected glides are
// cut at that rest.
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
const BURST_GAP_MS = 24;
/** Claim 1's finger starts here and moves down the screen. */
const BURST_Y0 = 300;
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
    w.__fl = { moves: [], end: null, ys: [], ts: [] };
    // one frame loop at a time: an older arm's loop stops
    const gen = (w.__flGen = (w.__flGen ?? 0) + 1);
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
      if (w.__flGen !== gen) return;
      w.__fl.ys.push(scrollY);
      w.__fl.ts.push(performance.now());
      if (w.__fl.ys.length < 600) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
const read = (s) => s.page.evaluate(() => window.__fl);

/** A finger along `pts` ([x, y], one move every 16 ms), ended by `end` (touchEnd or touchCancel). */
async function drag(s, pts, end = 'touchEnd') {
  await send(s, 'touchStart', [pts[0]]);
  for (const p of pts.slice(1)) {
    await send(s, 'touchMove', [p]);
    await s.page.waitForTimeout(16);
  }
  await s.cdp.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
}
/** n moves of dy px from (x, y0). */
const line = (x, y0, dy, n) =>
  Array.from({ length: n + 1 }, (_, i) => [x, y0 + dy * i]);
/** Swipes down the page by gestures (one at a time, each to rest) until the page rests on the Just Pulled rest. */
async function toJustPulled(s, t) {
  let y = await s.page.evaluate(() => scrollY);
  for (let i = 0; i < 14 && Math.abs(y - t.exitEnd) > 2; i++) {
    await s.step(1);
    y = (await stage.rest(s, 9000)).y;
  }
  return y;
}
/**
 * After the lift (the touchend's handling time): the page's speed over the
 * frame before it and the first three after it (px per 60 Hz frame), the
 * frames after it that stood still short of `to`, the highest and the
 * lowest scroll after it, and where it rests.
 */
function afterLift(log, to) {
  const lift = log.end?.[1] ?? Infinity;
  const i = log.ts.findIndex((t) => t >= lift);
  const a = Math.max(0, i - 1);
  const b = Math.min(log.ts.length - 1, a + 3);
  const speed =
    i < 0 || b <= a
      ? null
      : ((log.ys[b] - log.ys[a]) * FRAME_MS) / (log.ts[b] - log.ts[a]);
  let still = 0;
  const after = i < 0 ? [] : log.ys.slice(i);
  for (let k = Math.max(1, i); k >= 1 && k < log.ys.length; k++)
    if (
      Math.abs(log.ys[k] - log.ys[k - 1]) < 0.5 &&
      Math.abs(log.ys[k] - to) > 3
    )
      still++;
  return {
    speed,
    still,
    max: after.length ? Math.max(...after) : null,
    min: after.length ? Math.min(...after) : null,
    end: log.ys.at(-1),
  };
}
/** Whether the page's speed after the lift is the finger's (by the events' own times), within 40%. */
const sameSpeed = (page, finger) =>
  page !== null &&
  finger !== null &&
  finger > 0 &&
  page / finger >= 0.6 &&
  page / finger <= 1.6;
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
async function flick(s, holdMs = 0, liftNow = false, step = STEP) {
  await send(s, 'touchStart', [[X, Y0]]);
  for (let i = 1; i < MOVES; i++)
    await send(s, 'touchMove', [[X, Y0 - step * i]]);
  const last = send(s, 'touchMove', [[X, Y0 - step * MOVES]]);
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
 * it three 32 px moves down the screen about 24 ms apart and the lift right
 * behind the last,
 * sent without waiting for the page (it is busy), so it handles them in a
 * burst. The task outlasts the gesture several times over: a gesture as long
 * as the task reads the same speed on both clocks.
 */
async function burstFlick(s) {
  await send(s, 'touchStart', [[X, BURST_Y0]]);
  const busy = s.page.evaluate((ms) => {
    const t = performance.now();
    while (performance.now() - t < ms);
  }, LONG_TASK_MS);
  await wait(5);
  const sent = [];
  for (let i = 1; i <= BURST_MOVES; i++) {
    if (i > 1) await wait(BURST_GAP_MS);
    sent.push(send(s, 'touchMove', [[X, BURST_Y0 + BURST_STEP * i]]));
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
function expected(log, col = 0, room = Infinity) {
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
  // a glide arriving at the footer's rest stops there
  const glide = Math.min(room, Math.sign(v) * Math.abs(v) ** POWER);
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
    const footer = t.ends?.[0] ?? Infinity;
    const mid = Math.round(t.exitEnd + 20);
    await place(footer);
    await arm(s);
    await burstFlick(s);
    await s.settle({ quiet: 400, timeout: 6000 });
    let log = await read(s);
    let e = expected(log, 0);
    const h = expected(log, 1);
    let end = await s.page.evaluate(() => scrollY);
    let glide = end - log.end[2];
    await s.capture(
      'burst flick up from the footer at ' +
        Math.round(footer) +
        ': glide ' +
        Math.round(glide),
    );
    const tol = tolerance(e.glide);
    // the page falls back to its handling clock for event times that do not
    // fit it; the sample counts only when the two clocks ask different glides
    const clockFits =
      log.end[0] > 0 && log.end[0] <= log.end[1] + CLOCK_SLACK_MS;
    const valid1 =
      clockFits &&
      e.gap !== null &&
      e.gap < HOLD_MS &&
      e.glide < -40 &&
      // a free glide: it stops short of the paged edge (no hand-over to the lineup)
      log.end[2] + e.glide > t.edge + 4 &&
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

    // Claim 2: a long fast flick at the single pack: one move to the row back,
    // one wrap, and the page rests at the row (never pages on past it)
    const pack = t.ends?.[1];
    await place(pack);
    await arm(s);
    await flick(s, 0, true);
    await s.page.waitForTimeout(400);
    await s.capture('flick at the single pack: 400 ms after the release');
    await s.settle({ quiet: 800, timeout: 8000 });
    log = await read(s);
    e = expected(log);
    end = await s.page.evaluate(() => scrollY);
    let wraps = 0;
    for (let i = 1; i < log.ys.length; i++)
      if (log.ys[i - 1] - log.ys[i] > 1000) wraps++;
    await s.capture('flick at the single pack: rests at ' + Math.round(end));
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
    check(
      'flick-at-the-single-pack-wraps-once-to-the-row [phone]',
      pack !== undefined && wraps === 1 && Math.abs(end - t.r0) < 1,
      'from the single pack at ' +
        r1(pack ?? null) +
        ' (Last top ' +
        r1(t.lastTop) +
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
    await flick(s, 200, false, 40);
    await s.settle({ quiet: 400, timeout: 6000 });
    log = await read(s);
    e = expected(log);
    end = await s.page.evaluate(() => scrollY);
    glide = end - log.end[2];
    await s.capture('hold 200 ms then lift: glide ' + Math.round(glide));
    check(
      'hold-then-lift-no-glide [phone]',
      e.gap > HOLD_MS &&
        Math.abs(glide) < 1 &&
        log.end[2] > mid + 60 &&
        log.end[2] < footer - 1,
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

    // Claim 4: a long fast flick in Just Pulled is one move on to the single
    // pack: no stop at the footer, never past the pack (no wrap)
    await place(mid);
    await arm(s);
    await flick(s, 0, true);
    await s.settle({ quiet: 600, timeout: 8000 });
    end = await s.page.evaluate(() => scrollY);
    log = await read(s);
    const peak = Math.max(...log.ys);
    wraps = 0;
    for (let i = 1; i < log.ys.length; i++)
      if (log.ys[i - 1] - log.ys[i] > 1000) wraps++;
    // frames that held still on the way (after the lift, short of the pack)
    let still = 0;
    for (let i = 1; i < log.ys.length; i++)
      if (
        log.ys[i - 1] > log.end[2] &&
        log.ys[i] < (pack ?? Infinity) - 3 &&
        Math.abs(log.ys[i] - log.ys[i - 1]) < 0.5
      )
        still++;
    await s.capture('long flick in Just Pulled: rests at ' + Math.round(end));
    check(
      'long-flick-goes-on-to-the-single-pack [phone]',
      pack !== undefined &&
        Math.abs(end - pack) < 1 &&
        wraps === 0 &&
        peak < (t.lastTop ?? Infinity) &&
        still === 0,
      'from ' +
        mid +
        ': rests at ' +
        r1(end) +
        ' (single pack ' +
        r1(pack ?? null) +
        ', footer rest ' +
        r1(footer) +
        '); highest ' +
        r1(peak) +
        ' (Last top ' +
        r1(t.lastTop) +
        '); ' +
        wraps +
        ' wrap(s); ' +
        still +
        ' still frame(s) on the way',
    );

    // Claim 5: a swipe that starts on the Just Pulled rest (reached by
    // gestures) goes on to the single pack, starting at the finger's speed
    await toJustPulled(s, t);
    const jp = await s.page.evaluate(() => scrollY);
    await arm(s);
    await drag(s, line(X, 600, -28, 8));
    await s.settle({ quiet: 600, timeout: 8000 });
    log = await read(s);
    e = expected(log);
    let a = afterLift(log, pack);
    await s.capture(
      'swipe on the Just Pulled rest: rests at ' + Math.round(a.end),
    );
    check(
      'swipe-on-the-just-pulled-rest-goes-on-at-the-finger-speed [phone]',
      Math.abs(jp - t.exitEnd) < 1 &&
        t.freeFits === true &&
        Math.abs(a.end - pack) < 1 &&
        a.still === 0 &&
        sameSpeed(a.speed, e.v),
      'from ' +
        r1(jp) +
        ' (Just Pulled rest ' +
        r1(t.exitEnd) +
        ', fits the view ' +
        t.freeFits +
        '): rests at ' +
        r1(a.end) +
        ' (single pack ' +
        r1(pack) +
        '); finger ' +
        r1(e.v) +
        ' px per 60 Hz frame at the lift, page ' +
        r1(a.speed) +
        ' over the first frames after it; ' +
        a.still +
        ' still frame(s) on the way',
    );

    // Claim 6: a swipe from the Just Pulled rest that turns back before the
    // lift (200 px up the screen, 120 px back) settles back on that rest
    await toJustPulled(s, t);
    await arm(s);
    await drag(s, [...line(X, 600, -20, 10), ...line(X, 400, 20, 6).slice(1)]);
    await s.settle({ quiet: 600, timeout: 8000 });
    log = await read(s);
    a = afterLift(log, t.exitEnd);
    check(
      'reversed-swipe-settles-back-on-the-just-pulled-rest [phone]',
      Math.abs(a.end - t.exitEnd) < 1 &&
        a.max <= log.end[2] + 1 &&
        Math.max(...log.ys) < footer + 1,
      'let go at ' +
        r1(log.end[2]) +
        ' moving back up the page; after the lift highest ' +
        r1(a.max) +
        ', rests at ' +
        r1(a.end) +
        ' (Just Pulled rest ' +
        r1(t.exitEnd) +
        ', footer rest ' +
        r1(footer) +
        ')',
    );

    // Claim 7: a touch cancelled between the footer and the single pack (set
    // up on the footer rest; the finger pulls the page past it) leaves the
    // page on an end rest, not between them
    await place(footer);
    await arm(s);
    await drag(s, line(X, 600, -30, 6), 'touchCancel');
    await s.settle({ quiet: 600, timeout: 8000 });
    log = await read(s);
    const cut = Math.max(...log.ys);
    const at = log.ys.at(-1);
    check(
      'touchcancel-between-the-footer-and-the-pack-rests-on-an-end-rest [phone]',
      cut > footer + 20 &&
        (Math.abs(at - footer) < 1 || Math.abs(at - pack) < 1),
      'the finger pulled the page to ' +
        r1(cut) +
        ' (footer rest ' +
        r1(footer) +
        ', single pack ' +
        r1(pack) +
        '); cancelled, it rests at ' +
        r1(at),
    );

    s.checkNoErrors();
  } finally {
    await s.ctx.close();
  }

  // Claim 8: on a short phone (360x640) Just Pulled is taller than the view
  // at its rest: the first swipe there is one move to the footer's rest at
  // the finger's speed (no still frame), the next goes on to the single pack
  const sh = await stage.open(browser, 'phone', '/home-preview', {
    context: { viewport: { width: 360, height: 640 } },
  });
  try {
    const t = await sh.page.evaluate(() => window.__packStage.flow().table);
    const [f0, f1] = t.ends;
    await toJustPulled(sh, t);
    await arm(sh);
    await drag(sh, line(X, 470, -24, 8));
    await sh.settle({ quiet: 600, timeout: 8000 });
    let log = await read(sh);
    const e = expected(log);
    const a = afterLift(log, f0);
    await sh.capture('short phone, first swipe: rests at ' + Math.round(a.end));
    await arm(sh);
    await drag(sh, line(X, 470, -24, 8));
    await sh.settle({ quiet: 600, timeout: 8000 });
    log = await read(sh);
    const b = afterLift(log, f1);
    check(
      'short-phone-first-swipe-to-the-footer-then-the-pack [360x640]',
      t.freeFits === false &&
        Math.abs(a.end - f0) < 1 &&
        a.still === 0 &&
        sameSpeed(a.speed, e.v) &&
        Math.abs(b.end - f1) < 1 &&
        b.still === 0,
      'fits the view ' +
        t.freeFits +
        '; from the Just Pulled rest ' +
        r1(t.exitEnd) +
        ' the first swipe rests at ' +
        r1(a.end) +
        ' (footer rest ' +
        r1(f0) +
        '; finger ' +
        r1(e.v) +
        ', page ' +
        r1(a.speed) +
        ' px per 60 Hz frame at the lift; ' +
        a.still +
        ' still), the next at ' +
        r1(b.end) +
        ' (single pack ' +
        r1(f1) +
        '; ' +
        b.still +
        ' still)',
    );
    sh.checkNoErrors();
  } finally {
    await sh.ctx.close();
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
