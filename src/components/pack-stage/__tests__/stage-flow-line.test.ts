import { describe, expect, it } from 'vitest';

import { createFlowLine, type FlowLine } from '../stage-flow-line';

/** Frames every `dt` ms from `from` to `to`; returns the last frame. */
function run(l: FlowLine, from: number, to: number, dt = 16) {
  let f = l.frame(from);
  for (let now = from + dt; now <= to; now += dt) f = l.frame(now);
  return f;
}

/**
 * A drag of `px` (negative: the finger moves left) over `moves` frames
 * `dt` ms apart, then `hold` ms still, then the release; frames run on
 * until the line rests. Returns the resting frame.
 */
function drag(
  l: FlowLine,
  px: number,
  o: { moves?: number; dt?: number; hold?: number; t0?: number } = {},
) {
  const moves = o.moves ?? 8;
  const dt = o.dt ?? 16;
  let now = o.t0 ?? 0;
  const x0 = 300;
  l.grab(x0, now);
  l.frame(now);
  for (let k = 1; k <= moves; k++) {
    now += dt;
    l.drag(x0 + (px * k) / moves, now);
    l.frame(now);
  }
  const hold = o.hold ?? 0;
  for (let t = dt; t <= hold; t += dt) {
    now += dt;
    l.frame(now);
  }
  l.release(now);
  return { end: run(l, now, now + 3000, dt), at: now };
}

describe('flow line: the drag', () => {
  it('follows the finger at one pack per 100 px', () => {
    const l = createFlowLine();
    l.sync(2, 5);
    l.grab(300, 0);
    l.drag(250, 16);
    // finger left: later packs come to the centre
    expect(l.frame(16).pos).toBeCloseTo(2.5, 6);
  });

  it('a 200 px drag held still moves two packs; 100 px one; 40 px snaps back', () => {
    const a = createFlowLine();
    a.sync(1, 5);
    expect(drag(a, -200, { hold: 200 }).end.index).toBe(3);
    const b = createFlowLine();
    b.sync(1, 5);
    expect(drag(b, -100, { hold: 200 }).end.index).toBe(2);
    const c = createFlowLine();
    c.sync(1, 5);
    const r = drag(c, -40, { hold: 200 }).end;
    expect(r.index).toBe(1);
    expect(r.track).toBe(1);
  });

  it('always comes to rest on a pack, never between two', () => {
    for (const px of [-37, -149, -151, 73, 260, -999]) {
      const l = createFlowLine();
      l.sync(0, 5);
      const r = drag(l, px, { hold: 100 }).end;
      expect(r.moving).toBe(false);
      expect(Number.isInteger(r.track)).toBe(true);
      expect(r.track).toBe(r.index);
    }
  });
});

describe('flow line: the fling', () => {
  it('adds 8 times the last frame of movement, then rounds to a pack', () => {
    const l = createFlowLine();
    l.sync(0, 5);
    // 8 moves of 30 px, 16 ms apart: 2.4 packs, the last frame 0.3 packs
    const r = drag(l, -240, { moves: 8, dt: 16 }).end;
    // 2.4 + 8 * 0.3 = 4.8: the fifth pack (index 4 of 5... 5 mod 5 = 0)
    expect(r.index).toBe(0);
  });

  it('is the same at any frame rate (the delta is read per 60 Hz frame)', () => {
    const at60 = createFlowLine();
    at60.sync(0, 9);
    const at120 = createFlowLine();
    at120.sync(0, 9);
    const a = drag(at60, -240, { moves: 8, dt: 16 }).end;
    const b = drag(at120, -240, { moves: 16, dt: 8 }).end;
    expect(b.index).toBe(a.index);
  });

  it('a finger held still before letting go has no fling', () => {
    const l = createFlowLine();
    l.sync(0, 9);
    expect(drag(l, -240, { moves: 8, dt: 16, hold: 100 }).end.index).toBe(2);
  });
});

describe('flow line: the settle', () => {
  it('eases at 10 per second: about 90% of the way in 0.23 s', () => {
    const l = createFlowLine();
    l.sync(0, 5);
    l.step(1);
    l.frame(0);
    const f = run(l, 0, 230);
    expect(f.pos).toBeGreaterThan(0.88);
    expect(f.pos).toBeLessThan(0.92);
    expect(f.moving).toBe(true);
    const end = run(l, 230, 2000);
    expect(end.moving).toBe(false);
    expect(end.track).toBe(1);
  });
});

describe('flow line: without end', () => {
  it('wraps across the row: one pack on from the last is the first', () => {
    const l = createFlowLine();
    l.sync(4, 5);
    const r = drag(l, -100, { hold: 100 }).end;
    expect(r.index).toBe(0);
    expect(r.track).toBe(0);
    const back = drag(l, 100, { hold: 100, t0: 10000 }).end;
    expect(back.index).toBe(4);
  });

  it('twelve long drags the same way never reach an end; the track stays inside the row', () => {
    const l = createFlowLine();
    l.sync(0, 5);
    let t0 = 0;
    let moved = 0;
    for (let k = 0; k < 12; k++) {
      const before = l.pos();
      const r = drag(l, -1000, { hold: 100, t0 });
      t0 = r.at + 4000;
      moved += l.pos() - before;
      expect(r.end.track).toBeGreaterThanOrEqual(0);
      expect(r.end.track).toBeLessThan(5);
    }
    expect(moved).toBe(120);
  });

  it('a sync with the row it handed out keeps the position unbounded', () => {
    // the caller syncs before each gesture with the track it was given
    const l = createFlowLine();
    l.sync(0, 5);
    let t0 = 0;
    for (let k = 0; k < 4; k++) {
      const r = drag(l, -300, { hold: 100, t0 });
      t0 = r.at + 4000;
      l.sync(r.end.track, 5);
    }
    expect(l.pos()).toBe(12);
    expect(l.frame(t0).track).toBe(2);
    // a different row (a new length, or a track it did not hand out) is taken as given
    l.sync(1, 6);
    expect(l.pos()).toBe(1);
  });

  it('while moving, the track never leaves [-0.5, n - 0.5)', () => {
    const l = createFlowLine();
    l.sync(3, 5);
    l.grab(300, 0);
    for (let k = 1; k <= 60; k++) {
      l.drag(300 - k * 13, k * 16);
      const f = l.frame(k * 16);
      expect(f.track).toBeGreaterThanOrEqual(-0.5);
      expect(f.track).toBeLessThan(4.5);
    }
  });

  it('while easing (a step across the wrap, a fling), the track stays in [-0.5, n - 0.5)', () => {
    const l = createFlowLine();
    l.sync(4, 5);
    l.step(1);
    let f = l.frame(0);
    for (let now = 16; now < 1500; now += 16) {
      f = l.frame(now);
      expect(f.track).toBeGreaterThanOrEqual(-0.5);
      expect(f.track).toBeLessThan(4.5);
    }
    expect(f.index).toBe(0);
    const g = createFlowLine();
    g.sync(2, 5);
    g.grab(300, 0);
    g.frame(0);
    for (let k = 1; k <= 8; k++) {
      g.drag(300 - 30 * k, 16 * k);
      g.frame(16 * k);
    }
    g.release(130);
    for (let now = 144; now < 2500; now += 16) {
      const h = g.frame(now);
      expect(h.track).toBeGreaterThanOrEqual(-0.5);
      expect(h.track).toBeLessThan(4.5);
    }
  });

  it('a row of one pack never moves off it', () => {
    const l = createFlowLine();
    l.sync(0, 1);
    const r = drag(l, -350, { hold: 100 }).end;
    expect(r.index).toBe(0);
    expect(r.track).toBe(0);
  });
});

describe('flow line: keys and the sideways wheel', () => {
  it('a step moves one pack each way', () => {
    const l = createFlowLine();
    l.sync(2, 5);
    l.step(1);
    expect(run(l, 0, 2000).index).toBe(3);
    l.step(-1);
    l.step(-1);
    expect(run(l, 3000, 5000).index).toBe(1);
  });

  it('one sideways wheel gesture steps one pack; a new gesture after a pause steps again', () => {
    const l = createFlowLine();
    l.sync(0, 5);
    let now = 0;
    // a trackpad gesture: a burst of falling deltas 16 ms apart
    for (const d of [40, 38, 30, 22, 15, 9, 5, 3, 2]) {
      expect(l.wheel(d, now)).toBe(true);
      now += 16;
    }
    expect(run(l, now, now + 2000).index).toBe(1);
    now += 2200;
    l.wheel(-30, now);
    expect(run(l, now, now + 2000).index).toBe(0);
  });

  it('a gesture that starts with rising deltas still steps one pack', () => {
    const l = createFlowLine();
    l.sync(0, 5);
    let now = 0;
    for (const d of [1, 3, 6, 12, 20, 30, 24, 26, 18, 10, 6, 3]) {
      l.wheel(d, now);
      l.frame(now);
      now += 16;
    }
    expect(run(l, now, now + 2000).index).toBe(1);
  });

  it('a sideways wheel delta under 4 px is swallowed and moves nothing', () => {
    const l = createFlowLine();
    l.sync(0, 5);
    expect(l.wheel(3, 0)).toBe(true);
    expect(run(l, 0, 1000).index).toBe(0);
  });
});

describe('flow line: packs that cannot be picked', () => {
  it('the target moves on, the way the row went, to a pack that can be', () => {
    const l = createFlowLine({ canPick: (i) => i !== 2 });
    l.sync(1, 5);
    expect(drag(l, -100, { hold: 100 }).end.index).toBe(3);
    l.step(-1);
    expect(run(l, 9000, 11000).index).toBe(1);
  });
});

describe('flow line: sync', () => {
  it('takes the row as it rests, and is ignored while the line moves', () => {
    const l = createFlowLine();
    l.sync(3, 6);
    expect(l.frame(0).track).toBe(3);
    l.step(1);
    l.sync(0, 6);
    expect(run(l, 16, 2000).index).toBe(4);
  });
});
