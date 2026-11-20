import { describe, expect, it } from 'vitest';

import {
  PAGED_MS,
  SPIN_FOLLOW_MS,
  TOUCH_PAGE_PX,
  createSpinDriver,
  easeOutCubic,
  exitProgress,
  pagedProgress,
  pagedSpin,
  spinProgress,
} from '../stage-spin-driver';

// phone: pin 1.75 panels of 716 px, exit 1.25 panels
const RANGE = { start: 0, length: 1253, exit: 895 };
const END = RANGE.start + RANGE.length;
const EXIT_END = END + RANGE.exit;

/**
 * Ciao's measured page from the top (pack-stage/ciao-spin/desktop-wheel.json,
 * "wheel 100 at top"): [ms, px] of a 1115 px section, start fitted at 54 ms.
 */
const CIAO_DESKTOP_S0: [number, number][] = [
  [149, 196],
  [211, 314],
  [304, 470],
  [382, 605],
  [476, 683],
  [553, 785],
  [631, 843],
  [695, 917],
  [770, 958],
  [832, 992],
  [958, 1046],
  [1081, 1081],
  [1206, 1102],
  [1330, 1112],
  [1453, 1115],
];
/** phone-wheel.json "swipe up 120px at top": 1045 px section, start fitted at 772 ms. */
const CIAO_PHONE_S0: [number, number][] = [
  [836, 126],
  [897, 240],
  [959, 345],
  [1022, 441],
  [1084, 527],
  [1145, 604],
  [1206, 674],
  [1267, 735],
  [1329, 790],
  [1392, 838],
  [1516, 914],
  [1639, 969],
  [1763, 1006],
  [1886, 1029],
  [2008, 1040],
  [2131, 1044],
];

/** Runs a driver like the provider would: frames every 16 ms, scroll written back. */
function run(
  mode: 'paged' | 'free',
  o: { reducedMotion?: boolean; pagedRemap?: boolean } = {},
) {
  const drv = createSpinDriver({
    mode,
    reducedMotion: !!o.reducedMotion,
    pagedRemap: o.pagedRemap,
  });
  drv.setRange(RANGE);
  let scrollY = 0;
  let now = 0;
  const frame = () => {
    const f = drv.frame(scrollY, now);
    if (f.scrollTo !== null) scrollY = f.scrollTo;
    return f;
  };
  const r = {
    drv,
    frame,
    get scrollY() {
      return scrollY;
    },
    set scrollY(v: number) {
      scrollY = v;
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      let f = frame();
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        f = frame();
      }
      return f;
    },
    /** A vertical swipe: finger from y 600 by dy (negative = up = page down). */
    swipe(dy: number) {
      drv.touchStart(200, 600, scrollY, now);
      const moves = [600 + dy / 3, 600 + (2 * dy) / 3, 600 + dy].map((y) =>
        drv.touchMove(200, y, scrollY, now),
      );
      drv.touchEnd(scrollY, now);
      return moves;
    },
  };
  return r;
}

describe('paged wheel (Ciao 9.2)', () => {
  it('one notch scrolls the whole pin in 1.5 s on an ease-out cubic; the turn spin rides the remap', () => {
    const r = run('paged');
    r.frame();
    expect(r.drv.wheel(100, r.scrollY, r.now)).toBe(true);
    const t0 = r.now;
    let last = 0;
    for (let t = 16; t <= PAGED_MS; t += 16) {
      const f = r.advance(16);
      const p = easeOutCubic((r.now - t0) / PAGED_MS);
      expect(r.scrollY).toBeCloseTo(RANGE.length * p, 6);
      expect(f.spin).toBeCloseTo(pagedSpin(p, 'down'), 9);
      expect(f.spin).toBeGreaterThanOrEqual(last);
      last = f.spin;
    }
    const end = r.advance(32);
    expect(end.spin).toBe(1);
    expect(end.animating).toBe(false);
    expect(end.settled).toBe(true);
  });

  it('without the remap (the tip variant) the spin is the scroll progress, as Ciao', () => {
    const r = run('paged', { pagedRemap: false });
    r.frame();
    r.drv.wheel(100, 0, r.now);
    for (let k = 0; k < 40; k++) {
      const f = r.advance(16);
      expect(f.spin).toBeCloseTo(spinProgress(r.scrollY, RANGE), 9);
    }
  });

  it("matches Ciao's measured curves within 2% of the span", () => {
    for (const [pts, t0, span] of [
      [CIAO_DESKTOP_S0, 54, 1115],
      [CIAO_PHONE_S0, 772, 1045],
    ] as const) {
      let worst = 0;
      for (const [t, y] of pts)
        worst = Math.max(
          worst,
          Math.abs(easeOutCubic((t - t0) / PAGED_MS) - y / span),
        );
      expect(worst).toBeLessThan(0.02);
    }
  });

  it('locks input while it plays; ignores tiny deltas; the formed row and the exit are free', () => {
    const r = run('paged');
    r.frame();
    expect(r.drv.wheel(2, 0, r.now)).toBe(true); // consumed, no page
    expect(r.frame().animating).toBe(false);
    r.drv.wheel(100, r.scrollY, r.now);
    r.advance(400);
    expect(r.drv.wheel(100, r.scrollY, r.now)).toBe(true);
    expect(r.drv.wheel(-100, r.scrollY, r.now)).toBe(true); // reverse ignored
    r.advance(PAGED_MS);
    expect(r.frame().spin).toBe(1);
    // nearest stop is the pin end: the wheel is native both ways
    expect(r.drv.wheel(100, r.scrollY, r.now)).toBe(false);
    expect(r.drv.wheel(-100, r.scrollY, r.now)).toBe(false);
    // scrolled natively back up past the middle: paging again, back to the start
    r.scrollY = END * 0.4;
    expect(r.drv.wheel(-100, r.scrollY, r.now)).toBe(true);
    r.advance(PAGED_MS + 32);
    expect(r.scrollY).toBeCloseTo(0, 6);
    expect(r.frame().spin).toBe(0);
    // above the pin there is nothing to page to
    expect(r.drv.wheel(-100, r.scrollY, r.now)).toBe(false);
  });

  it('the exit follows native scrolling past the pin', () => {
    const r = run('paged');
    r.scrollY = END + RANGE.exit / 2;
    const f = r.advance(3000);
    expect(f.spin).toBe(1);
    expect(f.exit).toBeCloseTo(0.5, 3);
  });
});

describe('paged touch (Ciao 9.3)', () => {
  it('the page never follows the finger; release over 24 px pages one stop', () => {
    const r = run('paged');
    r.frame();
    const moves = r.swipe(-120);
    expect(moves.every(Boolean)).toBe(true); // consumed: the page did not move
    expect(r.frame().animating).toBe(true); // the page starts on release
    r.advance(PAGED_MS + 32);
    expect(r.scrollY).toBeCloseTo(END, 6);
    expect(r.frame().spin).toBe(1);
  });

  it('a swipe of 24 px or less goes back to the anchor', () => {
    const r = run('paged');
    r.frame();
    r.swipe(-TOUCH_PAGE_PX);
    r.advance(PAGED_MS + 32);
    expect(r.scrollY).toBe(0);
  });

  it('one stop per gesture, and at the formed row a swipe pages through the exit', () => {
    const r = run('paged');
    r.frame();
    r.swipe(-600); // long swipe: still one stop
    r.advance(PAGED_MS + 32);
    expect(r.scrollY).toBeCloseTo(END, 6);
    r.swipe(-120);
    r.advance(PAGED_MS + 32);
    expect(r.scrollY).toBeCloseTo(EXIT_END, 6);
    const f = r.frame();
    expect(f.exit).toBe(1);
    expect(f.spin).toBe(1);
    // past the exit: free (not armed)
    expect(r.swipe(-120).some(Boolean)).toBe(false);
  });

  it('a touch during a page freezes it; the release pages from the nearest stop', () => {
    const r = run('paged');
    r.frame();
    r.swipe(-120);
    r.advance(120); // part way (the ease-out is already past 20%)
    const mid = r.scrollY;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(END);
    r.drv.touchStart(200, 600, r.scrollY, r.now);
    r.advance(200);
    expect(r.scrollY).toBe(mid); // frozen while the finger is down
    r.drv.touchMove(200, 590, r.scrollY, r.now);
    r.drv.touchEnd(r.scrollY, r.now); // a 10 px nudge: back to the nearest stop
    r.advance(PAGED_MS + 32);
    expect(r.scrollY).toBeCloseTo(mid > END / 2 ? END : 0, 6);
  });

  it('a horizontal swipe passes to the track', () => {
    const r = run('paged');
    r.drv.touchStart(200, 600, 0, 0);
    expect(r.drv.touchMove(180, 599, 0, 0)).toBe(false);
    expect(r.drv.touchMove(100, 595, 0, 0)).toBe(false);
    r.drv.touchEnd(0, 0);
    expect(r.frame().animating).toBe(false);
  });
});

describe('the remap', () => {
  it('gives the turn gather about 200 ms and the travel most of the page, both ways', () => {
    const timeTo = (s: number, dir: 'down' | 'up') => {
      for (let t = 0; t <= PAGED_MS; t++) {
        const e = easeOutCubic(t / PAGED_MS);
        const sp = pagedSpin(dir === 'down' ? e : 1 - e, dir);
        if (dir === 'down' ? sp >= s : sp <= s) return t;
      }
      return PAGED_MS;
    };
    const gather = timeTo(0.15, 'down');
    expect(gather).toBeGreaterThan(150);
    expect(gather).toBeLessThan(260);
    expect(timeTo(0.85, 'down') - gather).toBeGreaterThan(750);
    expect(timeTo(0.15, 'up') - timeTo(0.85, 'up')).toBeGreaterThan(650);
    expect(1500 * (1 - Math.cbrt(1 - 0.15))).toBeLessThan(90);
    for (const dir of ['down', 'up'] as const)
      for (let s = 0; s <= 1; s += 0.01)
        expect(pagedSpin(pagedProgress(s, dir), dir)).toBeCloseTo(s, 9);
  });
});

describe('free (?spin=free)', () => {
  it('never consumes input; spin and exit follow the scroll with tau 150 ms', () => {
    const r = run('free');
    r.frame();
    expect(r.drv.wheel(100, 0, 0)).toBe(false);
    r.drv.touchStart(0, 600, 0, 0);
    expect(r.drv.touchMove(0, 500, 0, 0)).toBe(false);
    r.scrollY = RANGE.length;
    const f = r.advance(150);
    expect(f.spin).toBeCloseTo(1 - Math.exp(-150 / SPIN_FOLLOW_MS), 1);
    const g = r.advance(3000);
    expect(g.spin).toBe(1);
    expect(g.settled).toBe(true);
    r.scrollY = EXIT_END;
    expect(r.advance(3000).exit).toBe(1);
  });
});

describe('the easy paths', () => {
  it('reduced motion: spin 0, nothing consumed, no scroll writes', () => {
    for (const mode of ['paged', 'free'] as const) {
      const r = run(mode, { reducedMotion: true });
      expect(r.drv.wheel(100, 0, 0)).toBe(false);
      expect(r.swipe(-120).some(Boolean)).toBe(false);
      r.scrollY = 600;
      const f = r.advance(500);
      expect(f.spin).toBe(0);
      expect(f.exit).toBe(0);
      expect(f.scrollTo).toBeNull();
    }
  });

  it('no range (focus, no packs): spin 0 at once', () => {
    const r = run('free');
    r.scrollY = 600;
    r.advance(1000);
    r.drv.setRange(null);
    expect(r.frame().spin).toBe(0);
    expect(r.drv.wheel(100, 600, r.now)).toBe(false);
  });

  it('progress helpers clamp', () => {
    expect(spinProgress(-50, RANGE)).toBe(0);
    expect(spinProgress(99999, RANGE)).toBe(1);
    expect(spinProgress(100, null)).toBe(0);
    expect(exitProgress(END - 10, RANGE)).toBe(0);
    expect(exitProgress(EXIT_END + 10, RANGE)).toBe(1);
  });
});
