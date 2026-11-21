import { describe, expect, it } from 'vitest';

import { focusStops } from '../stage-focus-keys';
import {
  FLOW_SECTION_PANELS,
  RISE_START_VIEWPORT,
  WRAP_GUARD_MS,
  WRAP_UI_FADE_MS,
  flowAt,
  flowPosition,
  flowSlots,
  flowStops,
  flowTable,
  flowTerms,
  freeAnchor,
  freeAnchorY,
  lapAt,
  lapTrim,
  returnProgress,
  riseProgress,
  sameLap,
  spreadAt,
  wrapScrollAt,
  wrapTarget,
  wrapUiOpacity,
  type FlowAt,
  type FlowGeometry,
  type FlowTable,
} from '../stage-flow';
import { CIAO_EXIT_PANELS } from '../stage-spin';

// panel 800 px: one section S = 1000 px, so every rest is a round number
const GEO: FlowGeometry = {
  top: 0,
  panel: 800,
  stops: 6,
  viewport: 800,
  telegram: { top: 11000, bottom: 12000 },
  ret: { top: 12000, height: 1000 },
  last: { top: 13000, height: 801 },
};
const table = (g: Partial<FlowGeometry> = {}): FlowTable => {
  const t = flowTable({ ...GEO, ...g });
  if (!t) throw new Error('no table');
  return t;
};

describe('stage flow: the section table', () => {
  it('a section is 1.25 panels (CIAO_EXIT_PANELS); the lineup exit runs over two', () => {
    expect(FLOW_SECTION_PANELS).toBe(1.25);
    expect(FLOW_SECTION_PANELS).toBe(CIAO_EXIT_PANELS);
    expect(table().section).toBe(1000);
    const t = table();
    expect(t.exitEnd - t.exitStart).toBe(2 * t.section);
  });

  it('sleeve: the row, six stops one section apart, the lineup, the exit', () => {
    const t = table();
    expect(t.r0).toBe(0);
    expect(t.rests).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect(t.rl).toBe(7000);
    // the exit starts at the lineup rest and plays over the Lineup spacer
    // (RL to RL + S) and the Exit spacer (to RL + 2 S)
    expect(t.exitStart).toBe(7000);
    expect(t.exitEnd).toBe(9000);
    expect(t.edge).toBe(7500);
    expect(flowStops(t)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  });

  it('the stops are built once per table', () => {
    const t = table();
    expect(t.stops).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    expect(flowStops(t)).toBe(flowStops(t));
  });

  it('a measured Exit spacer sets the exit; the computed one is only the fallback', () => {
    const m = table({ exit: { top: 8100, height: 1100 } });
    expect(m.exitStart).toBe(7000);
    expect(m.exitEnd).toBe(9200);
    expect(flowAt(8100, m)).toEqual({ zone: 'free', span: 'exit', t: 0.5 });
    expect(m.rise!.start).toBe(10720);
    // the free part starts at the measured end
    expect(flowAt(9200, m)).toEqual({ zone: 'free', span: 'exit', t: 1 });
    expect(flowAt(9201, m).zone === 'free' && flowAt(9201, m)).toMatchObject({
      span: 'free',
    });
    // the spacer as the CSS lays it (R0 + 8 S, one section tall) is the fallback
    const css = table({ top: 120, exit: { top: 8120, height: 1000 } });
    const fallback = table({ top: 120 });
    expect([css.exitStart, css.exitEnd]).toEqual([
      fallback.exitStart,
      fallback.exitEnd,
    ]);
    // a spacer with no height yet (the flag is off): the fallback
    const z = table({ exit: { top: 8100, height: 0 } });
    expect([z.exitStart, z.exitEnd]).toEqual([7000, 9000]);
    // never above the lineup rest
    const up = table({ exit: { top: 6000, height: 500 } });
    expect(up.exitStart).toBe(7000);
    expect(up.exitEnd).toBe(7000);
  });

  it('starts from the flow top', () => {
    const t = table({ top: 120 });
    expect(t.r0).toBe(120);
    expect(t.rests[0]).toBe(1120);
    expect(t.rl).toBe(7120);
  });

  it('variants spread their stops over the same six-slot band', () => {
    expect(flowSlots(6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(flowSlots(5)).toEqual([1, 2.25, 3.5, 4.75, 6]);
    const four = flowSlots(4);
    expect(four[0]).toBe(1);
    expect(four[1]).toBeCloseTo(2.6667, 3);
    expect(four[2]).toBeCloseTo(4.3333, 3);
    expect(four[3]).toBe(6);
  });

  it('each variant keeps its stop count, rests on whole pixels, and never moves the lineup', () => {
    const counts = {
      sleeve: focusStops('sleeve').length,
      capsule: focusStops('capsule').length,
      noOdds: focusStops('noOdds').length,
    };
    expect(counts).toEqual({ sleeve: 6, capsule: 5, noOdds: 4 });
    const capsule = table({ stops: counts.capsule });
    const noOdds = table({ stops: counts.noOdds });
    expect(capsule.rests).toEqual([1000, 2250, 3500, 4750, 6000]);
    expect(noOdds.rests).toEqual([1000, 2667, 4333, 6000]);
    for (const t of [table(), capsule, noOdds]) {
      expect(t.rl).toBe(7000);
      expect(t.exitEnd).toBe(9000);
      expect(t.rests[0]).toBe(1000);
      expect(t.rests[t.rests.length - 1]).toBe(6000);
      for (const r of t.rests) expect(Number.isInteger(r)).toBe(true);
    }
  });

  it('no table for a zero, negative or non-finite panel', () => {
    expect(flowTable({ ...GEO, panel: 0 })).toBeNull();
    expect(flowTable({ ...GEO, panel: -800 })).toBeNull();
    expect(flowTable({ ...GEO, panel: Number.NaN })).toBeNull();
  });

  it('a pack with no stops pages straight from the row to the lineup', () => {
    const t = table({ stops: 0 });
    expect(flowSlots(0)).toEqual([]);
    expect(t.rests).toEqual([]);
    expect(flowStops(t)).toEqual([0, 7000]);
  });

  it('the rise runs from the Telegram top at 0.35 of the viewport to its bottom at the top', () => {
    expect(RISE_START_VIEWPORT).toBe(0.35);
    const t = table();
    expect(t.rise).toEqual({ start: 10720, end: 12000 });
    expect(t.ret).toEqual({ start: 12000, end: 13000 });
    expect(t.lastTop).toBe(13000);
  });

  it('Return and Last are optional until they have height', () => {
    const t = table({ ret: null, last: null });
    expect(t.ret).toBeNull();
    expect(t.lastTop).toBeNull();
    const z = table({
      ret: { top: 12000, height: 0 },
      last: { top: 12000, height: 0 },
    });
    expect(z.ret).toBeNull();
    expect(z.lastTop).toBeNull();
  });
});

describe('stage flow: the flow position P', () => {
  const t = table();

  it('paged: 0 at the row, k at stop k, n + 1 at the lineup, fractions between', () => {
    expect(flowAt(0, t)).toEqual({ zone: 'paged', p: 0 });
    expect(flowAt(-50, t)).toEqual({ zone: 'paged', p: 0 });
    expect(flowAt(1000, t)).toEqual({ zone: 'paged', p: 1 });
    expect(flowAt(3500, t)).toEqual({ zone: 'paged', p: 3.5 });
    expect(flowAt(7000, t)).toEqual({ zone: 'paged', p: 7 });
  });

  it('a capsule reaches the lineup at P = 6 (n + 1) over the same scroll', () => {
    const c = table({ stops: 5 });
    expect(flowAt(2250, c)).toEqual({ zone: 'paged', p: 2 });
    expect(flowAt(7000, c)).toEqual({ zone: 'paged', p: 6 });
    const at = flowAt(2875, c);
    expect(at.zone === 'paged' && at.p).toBeCloseTo(2.5, 6);
  });

  it('free: the named spans with their progress', () => {
    // the exit starts at the lineup rest and plays over both sections
    expect(flowAt(7001, t).zone === 'free' && flowAt(7001, t)).toMatchObject({
      span: 'exit',
    });
    expect(flowAt(7500, t)).toEqual({ zone: 'free', span: 'exit', t: 0.25 });
    expect(flowAt(8000, t)).toEqual({ zone: 'free', span: 'exit', t: 0.5 });
    expect(flowAt(8500, t)).toEqual({ zone: 'free', span: 'exit', t: 0.75 });
    expect(flowAt(9000, t)).toEqual({ zone: 'free', span: 'exit', t: 1 });
    const free = flowAt(9860, t);
    expect(free.zone === 'free' && free.span).toBe('free');
    expect(free.zone === 'free' && free.t).toBeCloseTo(0.5, 6);
    expect(flowAt(11360, t)).toEqual({ zone: 'free', span: 'rise', t: 0.5 });
    expect(flowAt(12500, t)).toEqual({ zone: 'free', span: 'ret', t: 0.5 });
    expect(flowAt(13000, t)).toEqual({ zone: 'free', span: 'last', t: 0 });
  });

  it('without a measured Telegram section the free span runs on, at progress 0', () => {
    const n = table({ telegram: null, ret: null, last: null });
    expect(n.rise).toBeNull();
    expect(flowAt(50000, n)).toEqual({ zone: 'free', span: 'free', t: 0 });
  });

  it('a page shorter than the rise start clamps the spans in order', () => {
    const s = table({ telegram: { top: 8600, bottom: 9200 } });
    expect(s.rise!.start).toBe(9000);
    expect(s.rise!.end).toBe(9200);
    expect(s.ret!.start).toBeGreaterThanOrEqual(s.rise!.end);
  });

  it('flowPosition is the inverse of flowAt everywhere', () => {
    for (let y = 0; y <= 13400; y += 50) {
      expect(flowPosition(flowAt(y, t), t)).toBeCloseTo(y, 6);
    }
  });

  it('P is kept across a re-measure with a new panel height (rotation)', () => {
    const wide = table();
    const narrow = table({
      panel: 312, // 390 px tall landscape at 0.8
      viewport: 390,
      telegram: { top: 5000, bottom: 5600 },
      ret: { top: 5600, height: 390 },
      last: { top: 5990, height: 391 },
    });
    const samples: FlowAt[] = [
      { zone: 'paged', p: 0 },
      { zone: 'paged', p: 3 },
      { zone: 'paged', p: 4.4 },
      { zone: 'paged', p: 7 },
      { zone: 'free', span: 'exit', t: 0.3 },
      { zone: 'free', span: 'free', t: 0.5 },
      { zone: 'free', span: 'rise', t: 0.25 },
      { zone: 'free', span: 'ret', t: 0.75 },
    ];
    for (const at of samples) {
      const y = flowPosition(at, wide);
      const kept = flowAt(y, wide);
      const moved = flowPosition(kept, narrow);
      const back = flowAt(moved, narrow);
      if (at.zone === 'paged') {
        expect(back.zone).toBe('paged');
        expect(back.zone === 'paged' && back.p).toBeCloseTo(at.p, 6);
      } else {
        expect(back.zone === 'free' && back.span).toBe(at.span);
        expect(back.zone === 'free' && back.t).toBeCloseTo(at.t, 6);
      }
      // and back to the first size: the same scroll
      expect(flowPosition(back, wide)).toBeCloseTo(y, 6);
    }
  });
});

describe('stage flow: rise and return progress from live rects', () => {
  it('rise: 0 above its start, 1 once the section bottom reaches the top', () => {
    // viewport 800: starts with the top at 280
    expect(riseProgress(400, 1400, 800)).toBe(0);
    expect(riseProgress(280, 1280, 800)).toBe(0);
    expect(riseProgress(-360, 640, 800)).toBeCloseTo(0.5, 6);
    expect(riseProgress(-1000, 0, 800)).toBe(1);
    expect(riseProgress(-1500, -500, 800)).toBe(1);
  });

  it('rise from rects matches the table span at the same scroll', () => {
    const t = table();
    for (const y of [10000, 10720, 11000, 11360, 11900, 12000, 12400]) {
      const at = flowAt(y, t);
      const fromRect = riseProgress(11000 - y, 12000 - y, 800);
      const fromTable =
        at.zone === 'free' && at.span === 'rise'
          ? at.t
          : y < t.rise!.start
            ? 0
            : 1;
      expect(fromRect).toBeCloseTo(fromTable, 6);
    }
  });

  it('a taller Just Pulled moves the Telegram rect, not the rise curve', () => {
    // the same Telegram rect gives the same progress whatever sits above it
    const short = table({ telegram: { top: 11000, bottom: 12000 } });
    const tall = table({
      telegram: { top: 14000, bottom: 15000 },
      ret: { top: 15000, height: 1000 },
      last: { top: 16000, height: 801 },
    });
    expect(short.rise!.end - short.rise!.start).toBe(
      tall.rise!.end - tall.rise!.start,
    );
    expect(short.rise!.start).toBe(10720);
    expect(tall.rise!.start).toBe(13720);
    expect(short.rl).toBe(tall.rl);
  });

  it('rise survives a zero viewport and a zero-height section', () => {
    expect(riseProgress(10, 10, 0)).toBe(0);
    expect(riseProgress(0, 0, 0)).toBe(1);
    expect(riseProgress(-1, -1, 0)).toBe(1);
    expect(Number.isFinite(riseProgress(5, 5, 0))).toBe(true);
  });

  it('return: over the spacer, 0 at its top and 1 at its end', () => {
    expect(returnProgress(100, 1000)).toBe(0);
    expect(returnProgress(0, 1000)).toBe(0);
    expect(returnProgress(-500, 1000)).toBe(0.5);
    expect(returnProgress(-1200, 1000)).toBe(1);
    expect(returnProgress(1, 0)).toBe(0);
    expect(returnProgress(0, 0)).toBe(1);
  });
});

describe('stage flow: term weights', () => {
  const t = table();
  const check = (at: FlowAt, n: number) => {
    const w = flowTerms(at, n).weights;
    const vals = Object.values(w);
    const sum = vals.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    for (const v of vals) expect(v).toBeGreaterThanOrEqual(0);
    expect(vals.filter((v) => v > 0).length).toBeLessThanOrEqual(2);
  };

  it('weights sum to 1 with at most two non-zero, over the whole page, for every variant', () => {
    for (const n of [6, 5, 4, 0]) {
      const tn = table({ stops: n });
      for (let y = -100; y <= 13800; y += 10) check(flowAt(y, tn), n);
    }
    for (let i = 0; i <= 700; i++) check({ zone: 'paged', p: i / 100 }, 6);
  });

  it('two non-zero weights only in the hand-off, and they are adjacent: focus and lineup', () => {
    for (let i = 0; i <= 700; i++) {
      const p = i / 100;
      const w = flowTerms({ zone: 'paged', p }, 6).weights;
      const on = Object.entries(w)
        .filter(([, v]) => v > 0)
        .map(([k]) => k)
        .sort();
      if (p > 6 + 1e-9 && p < 7 - 1e-9) expect(on).toEqual(['focus', 'lineup']);
      else expect(on.length).toBe(1);
    }
  });

  it('the focus term carries F up to Closing; the hand-off is power1InOut of the last section', () => {
    expect(flowTerms({ zone: 'paged', p: 2.5 }, 6)).toMatchObject({
      focus: 2.5,
      handoff: 0,
      weights: { focus: 1, lineup: 0 },
    });
    const mid = flowTerms({ zone: 'paged', p: 6.25 }, 6);
    expect(mid.focus).toBe(6);
    expect(mid.handoff).toBeCloseTo(0.125, 9); // power1InOut(0.25) = 2 * 0.25^2
    expect(mid.weights.lineup).toBeCloseTo(0.125, 9);
    expect(mid.weights.focus).toBeCloseTo(0.875, 9);
    expect(flowTerms({ zone: 'paged', p: 7 }, 6)).toMatchObject({
      handoff: 1,
      spread: 1,
      weights: { focus: 0, lineup: 1 },
    });
  });

  it('a capsule hands off between P 5 and 6', () => {
    expect(flowTerms({ zone: 'paged', p: 5 }, 5).weights.lineup).toBe(0);
    expect(flowTerms({ zone: 'paged', p: 5.5 }, 5).weights.lineup).toBeCloseTo(
      0.5,
      9,
    );
    expect(flowTerms({ zone: 'paged', p: 6 }, 5).weights.lineup).toBe(1);
  });

  it('free spans: exit on the lineup term, nothing drawn in free, then rise and return', () => {
    expect(flowTerms(flowAt(7600, t), 6)).toMatchObject({
      exit: 0.3,
      handoff: 1,
      spread: 1,
      weights: { lineup: 1 },
    });
    expect(flowTerms(flowAt(8600, t), 6)).toMatchObject({
      exit: 0.8,
      weights: { lineup: 1 },
    });
    expect(flowTerms(flowAt(9500, t), 6).weights.empty).toBe(1);
    expect(flowTerms(flowAt(11360, t), 6)).toMatchObject({
      rise: 0.5,
      weights: { rise: 1 },
    });
    expect(flowTerms(flowAt(12500, t), 6)).toMatchObject({
      ret: 0.5,
      spread: 3,
      weights: { return: 1 },
    });
    expect(flowTerms(flowAt(13200, t), 6)).toMatchObject({
      ret: 1,
      spread: 1,
      weights: { return: 1 },
    });
  });

  it('the spread falls from 5 row steps to 1', () => {
    expect(spreadAt(0)).toBe(5);
    expect(spreadAt(0.5)).toBe(3);
    expect(spreadAt(1)).toBe(1);
    expect(spreadAt(-1)).toBe(5);
    expect(spreadAt(2)).toBe(1);
    expect(flowTerms({ zone: 'paged', p: 6 }, 6).spread).toBe(5);
  });
});

describe('stage flow: the wrap', () => {
  it('triggers only when the scroll crosses Last top going down; the target keeps the overshoot', () => {
    expect(wrapTarget(12990, 13030, 13000)).toBe(30);
    expect(wrapTarget(12990, 13000, 13000)).toBe(0);
    expect(wrapTarget(13030, 12990, 13000)).toBeNull(); // up
    // already inside Last (a re-measure moved its top above a resting
    // page): the next downward movement wraps, keeping only this movement
    expect(wrapTarget(13010, 13050, 13000)).toBe(40);
    expect(wrapTarget(13300, 13310, 13000)).toBe(10);
    expect(wrapTarget(12000, 12500, 13000)).toBeNull(); // not reached
    expect(wrapTarget(13000, 13000, 13000)).toBeNull(); // no movement
    expect(wrapTarget(12990, 13030, null)).toBeNull(); // no Last yet
  });

  it('the guard scroll runs 1.2 s, ease-out cubic, to the row', () => {
    expect(WRAP_GUARD_MS).toBe(1200);
    expect(wrapScrollAt(0, 30, 0)).toBe(30);
    expect(wrapScrollAt(600, 800, 0)).toBeCloseTo(100, 6); // 1 - (0.5)^3 = 0.875
    expect(wrapScrollAt(1200, 30, 0)).toBe(0);
    expect(wrapScrollAt(5000, 30, 0)).toBe(0);
  });

  it('the row UI fades back in over 0.35 s', () => {
    expect(WRAP_UI_FADE_MS).toBe(350);
    expect(wrapUiOpacity(0)).toBe(0);
    expect(wrapUiOpacity(175)).toBeCloseTo(0.5, 9);
    expect(wrapUiOpacity(350)).toBe(1);
    expect(wrapUiOpacity(-10)).toBe(0);
  });
});

describe('stage flow: the lap at a flow position (plan 2.6)', () => {
  const live = { rise: 0.4, ret: 0.7 };
  it('nothing in the paged part or the exit; nothing drawn in free; then the live rise and return; Last holds the end', () => {
    expect(lapAt(null, live, false)).toBeNull();
    expect(lapAt({ zone: 'paged', p: 7 }, live, false)).toBeNull();
    expect(
      lapAt({ zone: 'free', span: 'exit', t: 0.5 }, live, false),
    ).toBeNull();
    expect(lapAt({ zone: 'free', span: 'free', t: 0.5 }, live, true)).toEqual({
      rise: 0,
      ret: 0,
      free: true,
      trim: true,
    });
    expect(lapAt({ zone: 'free', span: 'free', t: 0.9 }, live, false)).toEqual({
      rise: 0,
      ret: 0,
      free: true,
      trim: false,
    });
    expect(lapAt({ zone: 'free', span: 'rise', t: 0.1 }, live, true)).toEqual({
      rise: 0.4,
      ret: 0,
      free: false,
      trim: false,
    });
    expect(lapAt({ zone: 'free', span: 'ret', t: 0.1 }, live, false)).toEqual({
      rise: 1,
      ret: 0.7,
      free: false,
      trim: false,
    });
    expect(lapAt({ zone: 'free', span: 'last', t: 0 }, live, false)).toEqual({
      rise: 1,
      ret: 1,
      free: false,
      trim: false,
    });
  });

  it('only the chosen pack is kept from a quarter viewport past the exit end to a quarter viewport before the rise, so both ends find the packs loaded', () => {
    const t = table(); // exit end 9000, rise start 10720, viewport 800
    expect(lapTrim(9199, t, 800)).toBe(false);
    expect(lapTrim(9200, t, 800)).toBe(true);
    expect(lapTrim(10519, t, 800)).toBe(true);
    expect(lapTrim(10520, t, 800)).toBe(false);
    expect(lapTrim(12500, t, 800)).toBe(false);
    // no measured rise: trimmed on from a quarter viewport past the exit end
    expect(lapTrim(20000, table({ telegram: null }), 800)).toBe(true);
    // a free span shorter than both margins: never trimmed
    expect(
      lapTrim(9150, table({ telegram: { top: 9600, bottom: 10600 } }), 800),
    ).toBe(false);
  });
});

describe('stage flow: the free part kept across a re-measure (rotation, plan 2.9 fault 3)', () => {
  // sections in document scroll px: opening, Just Pulled, Telegram, Return, Last
  const tall = [
    { top: 9000, height: 400 },
    { top: 9400, height: 1600 },
    { top: 11000, height: 1000 },
    { top: 12000, height: 1000 },
    { top: 13000, height: 801 },
  ];
  it('finds the section under the viewport middle and the share of it there', () => {
    expect(freeAnchor(9800, tall, 800)).toEqual({
      i: 1,
      frac: (10200 - 9400) / 1600,
    });
    expect(freeAnchor(8000, tall, 800)).toBeNull(); // above the first
    expect(freeAnchor(14000, tall, 800)).toEqual({ i: 4, frac: 1 });
  });
  it('puts the same share of the same section under the middle of the new viewport', () => {
    // turned: the sections reflow shorter and the viewport is lower
    const wide = [
      { top: 5000, height: 300 },
      { top: 5300, height: 900 },
      { top: 6200, height: 700 },
      { top: 6900, height: 500 },
      { top: 7400, height: 391 },
    ];
    const a = freeAnchor(9800, tall, 800)!;
    const y = freeAnchorY(a, wide, 390);
    expect(y + 195).toBeCloseTo(5300 + 900 * a.frac, 6);
    // and back
    expect(freeAnchorY(freeAnchor(y, wide, 390)!, tall, 800)).toBeCloseTo(
      9800,
      6,
    );
  });
});

describe('stage flow: when the lap state changes (the free-span trim)', () => {
  const free = (trim: boolean) => ({ rise: 0, ret: 0, free: true, trim });
  it('a trim that switches on or off is a change', () => {
    expect(sameLap(free(false), free(true))).toBe(false);
    expect(sameLap(free(true), free(false))).toBe(false);
  });
  it('the same values are the same lap; null only equals null', () => {
    expect(sameLap(free(true), free(true))).toBe(true);
    expect(sameLap(null, null)).toBe(true);
    expect(sameLap(free(false), null)).toBe(false);
    expect(sameLap(null, free(false))).toBe(false);
  });
  it('rise, return and free each count', () => {
    const a = { rise: 0.5, ret: 0, free: false, trim: false };
    expect(sameLap(a, { ...a, rise: 0.6 })).toBe(false);
    expect(sameLap(a, { ...a, ret: 0.1 })).toBe(false);
    expect(sameLap(a, { ...a, free: true })).toBe(false);
  });
  it('a normal scroll into the free span reaches the trim (lapAt then sameLap)', () => {
    // entering from the exit: the first free frame is not yet past the trim
    // line, a later one is; the second must register as a change
    const at = { zone: 'free', span: 'free' } as unknown as FlowAt;
    const first = lapAt(at, { rise: 0, ret: 0 }, false);
    const later = lapAt(at, { rise: 0, ret: 0 }, true);
    expect(later?.trim).toBe(true);
    expect(sameLap(first, later)).toBe(false);
  });
});
