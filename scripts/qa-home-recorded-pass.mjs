// qa-home-recorded-pass.mjs: one continuous recorded visit of /home-preview per size, for a person to look at.
// It records; it does not judge feel. It fails only on a page error, a thrown step, or a leg it could not reach.
//   Forward: the row, a tap on the centred pack, every stop, the lineup, a sideways pick, the free part with the
//            Just Pulled drawer, the rise, the return, and the loop back to the row.
//   Backward: from the lineup up to the row.
// A labelled frame every 200 ms (written as <size>-<leg>-<nnn>-<phase>.jpg) and two contact sheets per size
// (SHEET-<size>-forward.png, SHEET-<size>-backward.png) go to --out (default: the kit's output folder).
// Real gestures only: CDP touch swipes and taps on the phone, wheel notches, keys and clicks on the desktop.
// Run from the repo root, through the machine's test queue, one size per job so each stays under 3 minutes:
//   node <tools>/qa-with-lock.mjs --runner=<lane> -- node scripts/qa-home-recorded-pass.mjs --only=phone [--base=URL]
//   node <tools>/qa-with-lock.mjs --runner=<lane> -- node scripts/qa-home-recorded-pass.mjs --only=desktop [--base=URL]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as qa from './lib/qa-kit.mjs';

const { stage, check, info } = qa;
const FRAME_MS = 200;
const SIZES = qa.sizes();
qa.deadline(170000 * SIZES.length);

/** Where the visitor is, from the flow's own table (read only). */
const where = (s) =>
  s.page.evaluate(() => {
    const ps = window.__packStage;
    const fl = ps?.flow?.() ?? null;
    const f = ps?.focus?.() ?? null;
    const t = fl?.table ?? null;
    const y = scrollY;
    const r0 = t?.r0 ?? fl?.stops?.[0] ?? 0;
    // the table first (the focus stays on past the stops), then the stop,
    // then the row
    let phase = 'row';
    if (t && t.lastTop != null && y >= t.lastTop - 1) phase = 'wrap';
    else if (t && t.ret && y >= t.ret.start) phase = 'return';
    else if (t && t.rise && y >= t.rise.start) phase = 'rise';
    else if (t && y > t.exitEnd) phase = 'free';
    else if (t && y >= t.rl - 2) phase = 'lineup';
    else if (f?.on) phase = 'stop-' + Math.round(f.focus);
    const jp = document.querySelector('[data-jp-drawer]');
    const jb = jp?.getBoundingClientRect();
    return {
      y: Math.round(y),
      phase,
      busy: !!fl?.busy,
      r0: Math.round(r0),
      id: ps?.state?.focusOn?.id ?? null,
      jpInView: !!jb && jb.bottom > 0 && jb.top < innerHeight,
      jpLive: !!document.querySelector('[data-jp][data-jp-live="1"]'),
    };
  });

/** Takes a labelled frame every FRAME_MS until stopped. */
function recorder(s, leg) {
  const frames = [];
  let on = true;
  const t0 = Date.now();
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      try {
        const [buf, w] = await Promise.all([
          s.page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' }),
          where(s),
        ]);
        const n = String(frames.length).padStart(3, '0');
        const label =
          ((t - t0) / 1000).toFixed(1) +
          ' s ' +
          w.phase +
          ' y' +
          w.y +
          (w.jpInView ? ' JP' : '');
        writeFileSync(
          join(qa.OUT, s.size + '-' + leg + '-' + n + '-' + w.phase + '.jpg'),
          buf,
        );
        frames.push({ label, buf, phase: w.phase });
      } catch (e) {
        if (on)
          info(
            'frame-skipped [' + s.size + ']',
            String(e?.message ?? e).split('\n')[0],
          );
      }
      const wait = FRAME_MS - (Date.now() - t);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return {
    frames,
    stop: async () => {
      on = false;
      await loop;
      return frames;
    },
  };
}

/** One contact sheet of a leg's frames, drawn in a page of the same browser. */
async function contactSheet(browser, size, leg, frames) {
  const width = size === 'phone' ? 96 : 200;
  const cols = size === 'phone' ? 14 : 7;
  const ctx = await browser.newContext({
    viewport: { width: cols * (width + 6) + 6, height: 400 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html =
    '<body style="margin:0;background:#1b1b1b;color:#eee;font:10px/1.2 Segoe UI,sans-serif;display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px;padding:6px">' +
    '<div style="width:100%;font-size:13px">' +
    esc(
      qa.BASE +
        ' | ' +
        size +
        ' ' +
        leg +
        ' | ' +
        frames.length +
        ' frames, one per ' +
        FRAME_MS +
        ' ms',
    ) +
    '</div>' +
    frames
      .map(
        (f, i) =>
          '<figure style="margin:0;width:' +
          width +
          'px"><figcaption>' +
          i +
          '. ' +
          esc(f.label) +
          '</figcaption><img style="width:' +
          width +
          'px;display:block" src="data:image/jpeg;base64,' +
          f.buf.toString('base64') +
          '"></figure>',
      )
      .join('') +
    '</body>';
  await page.setContent(html, { waitUntil: 'load' });
  const path = join(qa.OUT, 'SHEET-' + size + '-' + leg + '.png');
  await page.screenshot({ path, fullPage: true });
  await ctx.close();
  info(
    'sheet [' + size + ' ' + leg + ']',
    path.replace(/\\/g, '/') + ' (' + frames.length + ' frames)',
  );
}

/** A sideways move along the lineup: a swipe on the phone, a key on the desktop. */
const sideways = async (s) => {
  const { width, height } = s.page.viewportSize();
  if (s.cdp)
    await s.swipe(width * 0.75, height * 0.5, width * 0.25, height * 0.5);
  else await s.keys('ArrowRight');
};
/** A free scroll down: a long swipe on the phone, three wheel notches on the desktop. */
const scrollOn = async (s) => {
  const { width, height } = s.page.viewportSize();
  if (s.cdp)
    await s.swipe(width / 2, height * 0.8, width / 2, height * 0.25, {
      steps: 8,
      dt: 16,
      hold: 120,
    });
  else for (let i = 0; i < 3; i++) await s.wheel(120);
};

/** Steps (one swipe or wheel notch each) while keepGoing(reading) holds, up to max; returns the last reading. */
async function stepWhile(s, dir, keepGoing, max) {
  let r = await where(s);
  for (let i = 0; i < max && keepGoing(r); i++) {
    await s.step(dir);
    await stage.rest(s);
    r = await where(s);
  }
  return r;
}

const browser = await qa.launch();
try {
  for (const size of SIZES) {
    const s = await stage.open(browser, size, '/home-preview');
    const seen = new Set();
    try {
      // forward
      await stage.rest(s);
      let rec = recorder(s, 'forward');
      await s.page.waitForTimeout(1000);
      const t = await stage.centreTile(s);
      if (!t) throw new Error('no centred pack to tap at the row');
      await s.tap(t.x, t.y);
      await stage.rest(s);
      let r = await where(s);
      seen.add(r.phase);
      // every stop, then the lineup
      r = await stepWhile(
        s,
        1,
        (w) => (seen.add(w.phase), w.phase.startsWith('stop-')),
        10,
      );
      seen.add(r.phase);
      const stops = [...seen].filter((p) => p.startsWith('stop-'));
      check(
        'forward-reached-every-stop [' + size + ']',
        stops.length >= 6,
        stops.join(', '),
      );
      check(
        'forward-reached-the-lineup [' + size + ']',
        r.phase === 'lineup',
        'phase ' + r.phase + ' y' + r.y,
      );
      await s.page.waitForTimeout(600);
      const before = r.id;
      await sideways(s);
      await stage.rest(s);
      r = await where(s);
      info('sideways-pick [' + size + ']', before + ' to ' + r.id);
      await s.page.waitForTimeout(600);
      // the free part, the drawer, the rise, the return, the wrap to the row
      let wrapped = false;
      let jp = false;
      let maxY = r.y;
      for (let i = 0; i < 80 && !wrapped; i++) {
        await scrollOn(s);
        await s.page.waitForTimeout(250);
        r = await where(s);
        seen.add(r.phase);
        if (r.jpInView) {
          if (!jp) await s.page.waitForTimeout(1200); // let the drawer show
          jp = true;
        }
        maxY = Math.max(maxY, r.y);
        if (maxY > r.r0 + 2000 && r.y < r.r0 + 400) wrapped = true;
      }
      await stage.rest(s);
      r = await where(s);
      await s.page.waitForTimeout(800);
      const fwd = await rec.stop();
      // the free part can be shorter than one gesture (a short first
      // section): the recorded frames count as well as the polls
      const framed = new Set([...seen, ...fwd.map((f) => f.phase)]);
      check(
        'forward-passed-the-free-part [' + size + ']',
        framed.has('free'),
        [...framed].join(', '),
      );
      check(
        'forward-saw-the-just-pulled-drawer [' + size + ']',
        jp,
        jp ? 'in view' : 'never in view',
      );
      check(
        'forward-rise-and-return [' + size + ']',
        seen.has('rise') && seen.has('return'),
        [...seen].join(', '),
      );
      check(
        'forward-looped-to-the-row [' + size + ']',
        wrapped && r.phase === 'row' && Math.abs(r.y - r.r0) < 2,
        'y' + r.y + ' r0 ' + r.r0 + ' phase ' + r.phase,
      );
      await contactSheet(browser, size, 'forward', fwd);

      // backward: down to the lineup first (by position, not recorded), then
      // up to the row
      await s.tap(
        ...(await (async () => {
          const c = await stage.centreTile(s);
          return c ? [c.x, c.y] : [0, 0];
        })()),
      );
      await stage.rest(s);
      r = await stepWhile(s, 1, (w) => w.phase !== 'lineup', 10);
      if (r.phase !== 'lineup')
        throw new Error(
          'could not reach the lineup for the backward leg (phase ' +
            r.phase +
            ')',
        );
      rec = recorder(s, 'backward');
      await s.page.waitForTimeout(600);
      const back = new Set();
      r = await stepWhile(
        s,
        -1,
        (w) => (
          back.add(w.phase),
          !(w.phase === 'row' && Math.abs(w.y - w.r0) < 2)
        ),
        12,
      );
      back.add(r.phase);
      await s.page.waitForTimeout(800);
      const bwd = await rec.stop();
      check(
        'backward-lineup-to-the-row [' + size + ']',
        r.phase === 'row' && Math.abs(r.y - r.r0) < 2,
        [...back].join(' > ') + '; y' + r.y,
      );
      await contactSheet(browser, size, 'backward', bwd);
      check(
        'no-page-errors [' + size + ']',
        s.errors.length === 0,
        s.errors.slice(0, 3).join(' | ') || 'none',
      );
      if (s.failed.length)
        info(
          'failed-requests [' + size + ']',
          s.failed.length + ': ' + s.failed.slice(0, 3).join(' | '),
        );
    } finally {
      await s.ctx.close();
    }
  }
} catch (e) {
  check(
    'script',
    false,
    String(e?.stack ?? e)
      .split('\n')
      .slice(0, 2)
      .join(' '),
  );
} finally {
  await qa.done();
}
