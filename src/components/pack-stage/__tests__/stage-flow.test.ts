import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { focusStops } from '../stage-focus-keys';
import {
  FLOW_DETAIL_SLOTS,
  FLOW_SECTION_PANELS,
  RISE_START_VIEWPORT,
  WRAP_GUARD_MS,
  WRAP_UI_FADE_MS,
  flowAt,
  flowPosition,
  flowSlots,
  flowTable,
  freeAnchor,
  freeAnchorY,
  offPlace,
  lapAt,
  lapTrim,
  returnProgress,
  riseProgress,
  sameLap,
  spreadAt,
  wrapScrollAt,
  wrapTarget,
  type FlowAt,
  type FlowGeometry,
  type FlowTable,
} from '../stage-flow';

// panel 800 px: one section S = 1000 px, so every rest is a round number
const GEO: FlowGeometry = {
  top: 0,
  panel: 800,
  stops: 6,
  viewport: 800,
  riseSection: { top: 11000, bottom: 12000 },
  ret: { top: 12000, height: 1000 },
  last: { top: 13000, height: 801 },
};
const table = (g: Partial<FlowGeometry> = {}): FlowTable => {
  const t = flowTable({ ...GEO, ...g });
  if (!t) throw new Error('no table');
  return t;
};

describe('stage flow: the section table', () => {
  it('a section is 1.25 panels; the lineup exit runs over one', () => {
    expect(FLOW_SECTION_PANELS).toBe(1.25);
    expect(table().section).toBe(1000);
    const t = table();
    expect(t.exitEnd - t.exitStart).toBe(t.section);
  });

  it('sleeve: the row, six stops one section apart, the lineup, the exit', () => {
    const t = table();
    expect(t.r0).toBe(0);
    expect(t.rests).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect(t.rl).toBe(7000);
    // the exit starts at the lineup rest and plays over the Lineup spacer
    // only (RL to RL + S): Just Pulled's top meets the viewport top there
    expect(t.exitStart).toBe(7000);
    expect(t.exitEnd).toBe(8000);
    // the paged edge lies inside the exit, half a section past the lineup
    expect(t.edge).toBe(7500);
    expect(t.stops).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
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
      expect(t.exitEnd).toBe(8000);
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
    expect(t.stops).toEqual([0, 7000]);
  });

  it("the rise runs from the last section's top at 0.35 of the viewport to its bottom at the top", () => {
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
    // the exit starts at the lineup rest and plays over one section
    expect(flowAt(7001, t).zone === 'free' && flowAt(7001, t)).toMatchObject({
      span: 'exit',
    });
    expect(flowAt(7250, t)).toEqual({ zone: 'free', span: 'exit', t: 0.25 });
    expect(flowAt(7500, t)).toEqual({ zone: 'free', span: 'exit', t: 0.5 });
    expect(flowAt(7750, t)).toEqual({ zone: 'free', span: 'exit', t: 0.75 });
    expect(flowAt(8000, t)).toEqual({ zone: 'free', span: 'exit', t: 1 });
    expect(flowAt(8001, t).zone === 'free' && flowAt(8001, t)).toMatchObject({
      span: 'free',
    });
    const free = flowAt(9360, t);
    expect(free.zone === 'free' && free.span).toBe('free');
    expect(free.zone === 'free' && free.t).toBeCloseTo(0.5, 6);
    expect(flowAt(11360, t)).toEqual({ zone: 'free', span: 'rise', t: 0.5 });
    expect(flowAt(12500, t)).toEqual({ zone: 'free', span: 'ret', t: 0.5 });
    expect(flowAt(13000, t)).toEqual({ zone: 'free', span: 'last', t: 0 });
  });

  it('without a measured last section the free span runs on, at progress 0', () => {
    const n = table({ riseSection: null, ret: null, last: null });
    expect(n.rise).toBeNull();
    expect(flowAt(50000, n)).toEqual({ zone: 'free', span: 'free', t: 0 });
  });

  it('a page shorter than the rise start clamps the spans in order', () => {
    const s = table({ riseSection: { top: 7600, bottom: 8200 } });
    expect(s.rise!.start).toBe(8000);
    expect(s.rise!.end).toBe(8200);
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
      riseSection: { top: 5000, bottom: 5600 },
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

describe('stage flow: the table follows whatever sections the page lists', () => {
  // The sections stack from the exit's end (8000: one section past the
  // lineup rest), then Return (one section) and Last. The table knows only
  // the last section's rect, never a section by name.
  const VP = 800;
  const shape = (heights: number[]) => {
    let y = 8000;
    const rects = heights.map((h) => {
      const r = { top: y, bottom: y + h };
      y += h;
      return r;
    });
    const t = table({
      viewport: VP,
      riseSection: rects[rects.length - 1]!,
      ret: { top: y, height: 1000 },
      last: { top: y + 1000, height: VP + 1 },
    });
    return { t, rects, end: y };
  };
  const cases: [string, number[]][] = [
    ['one section, shorter than the viewport', [400]],
    ['one section, taller than the viewport', [1500]],
    ['three sections, the last shorter than the viewport', [1800, 900, 400]],
    ['three sections, the last taller than the viewport', [1800, 900, 1500]],
  ];

  for (const [name, heights] of cases) {
    it(`${name}: exit end, free span, rise, Return, Last and the wrap`, () => {
      const { t, rects, end } = shape(heights);
      const lastRect = rects[rects.length - 1]!;
      // the exit ends where the first section starts
      expect(t.exitEnd).toBe(8000);
      expect(rects[0]!.top).toBe(t.exitEnd);
      // the rise: the last section's top at 0.35 of the viewport, never
      // before the exit's end, to its bottom at the top
      const riseStart = Math.max(
        t.exitEnd,
        lastRect.top - RISE_START_VIEWPORT * VP,
      );
      expect(t.rise).toEqual({ start: riseStart, end: lastRect.bottom });
      expect(t.ret).toEqual({ start: end, end: end + 1000 });
      expect(t.lastTop).toBe(end + 1000);
      // the free span runs from the exit's end to the rise
      if (riseStart > t.exitEnd) {
        const mid = flowAt((t.exitEnd + riseStart) / 2, t);
        expect(mid.zone === 'free' && mid.span).toBe('free');
      } else {
        // nothing between the exit and the rise: the first pixel past the
        // exit is the rise
        const next = flowAt(t.exitEnd + 1, t);
        expect(next.zone === 'free' && next.span).toBe('rise');
      }
      const inRise = flowAt((t.rise!.start + t.rise!.end) / 2, t);
      expect(inRise.zone === 'free' && inRise.span).toBe('rise');
      const inRet = flowAt(end + 500, t);
      expect(inRet).toEqual({ zone: 'free', span: 'ret', t: 0.5 });
      expect(flowAt(t.lastTop!, t)).toEqual({
        zone: 'free',
        span: 'last',
        t: 0,
      });
      // the wrap: a movement across Last's top keeps only its overshoot
      expect(wrapTarget(t.lastTop! - 10, t.lastTop! + 30, t.lastTop)).toBe(30);
      expect(wrapTarget(t.lastTop! - 40, t.lastTop! - 1, t.lastTop)).toBeNull();
      // and the position round-trips through the whole page
      for (let y = 0; y <= t.lastTop! + VP; y += 50)
        expect(flowPosition(flowAt(y, t), t)).toBeCloseTo(y, 6);
    });
  }

  it('one short section: no pack trim, since the rise follows the exit at once', () => {
    const { t } = shape([400]);
    for (let y = t.exitEnd; y <= t.rise!.end; y += 25)
      expect(lapTrim(y, t, VP)).toBe(false);
  });

  it('three sections: only the chosen pack is kept between the exit and the rise', () => {
    const { t } = shape([1800, 900, 400]);
    expect(lapTrim(t.exitEnd + VP, t, VP)).toBe(true);
    expect(lapTrim(t.rise!.start - VP * 0.1, t, VP)).toBe(false);
  });

  it('the rise from the live rect matches the table for a last section of any height', () => {
    for (const heights of [[400], [1800, 900, 1500]]) {
      const { t, rects } = shape(heights);
      const r = rects[rects.length - 1]!;
      for (let y = t.rise!.start; y <= t.rise!.end; y += 40) {
        const at = flowAt(y, t);
        const fromTable = at.zone === 'free' && at.span === 'rise' ? at.t : 1;
        // the live rect starts the rise at 0.35 of the viewport; the table
        // clamps its start to the exit's end, so they agree once the section
        // top is that far up
        if (r.top - RISE_START_VIEWPORT * VP >= t.exitEnd)
          expect(riseProgress(r.top - y, r.bottom - y, VP)).toBeCloseTo(
            fromTable,
            6,
          );
      }
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

  it("a taller first section moves the last section's rect, not the rise curve", () => {
    // the same last-section rect gives the same progress whatever sits above it
    const short = table({ riseSection: { top: 11000, bottom: 12000 } });
    const tall = table({
      riseSection: { top: 14000, bottom: 15000 },
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

describe('stage flow: the row spread', () => {
  it('the spread falls from 5 row steps to 1', () => {
    expect(spreadAt(0)).toBe(5);
    expect(spreadAt(0.5)).toBe(3);
    expect(spreadAt(1)).toBe(1);
    expect(spreadAt(-1)).toBe(5);
    expect(spreadAt(2)).toBe(1);
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
  });
});

describe('stage flow: the lap at a flow position', () => {
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
    const t = table(); // exit end 8000, rise start 10720, viewport 800
    expect(lapTrim(8199, t, 800)).toBe(false);
    expect(lapTrim(8200, t, 800)).toBe(true);
    expect(lapTrim(10519, t, 800)).toBe(true);
    expect(lapTrim(10520, t, 800)).toBe(false);
    expect(lapTrim(12500, t, 800)).toBe(false);
    // no measured rise: trimmed on from a quarter viewport past the exit end
    expect(lapTrim(20000, table({ riseSection: null }), 800)).toBe(true);
    // a free span shorter than both margins: never trimmed
    expect(
      lapTrim(8150, table({ riseSection: { top: 8600, bottom: 9600 } }), 800),
    ).toBe(false);
  });
});

describe('stage flow: the first section follows the lineup directly', () => {
  // the page as laid out now: the first section starts where the Lineup spacer
  // ends (R0 + 8 S)
  const page: Partial<FlowGeometry> = {
    riseSection: { top: 10000, bottom: 11000 },
    ret: { top: 11000, height: 1000 },
    last: { top: 12000, height: 801 },
  };
  const t = table(page);
  const sections = [
    { top: 8000, height: 2000 }, // the first section
    { top: 10000, height: 1000 }, // the last section
    { top: 11000, height: 1000 }, // Return
    { top: 12000, height: 801 }, // Last
  ];

  it("the exit ends where the first section's top meets the viewport top", () => {
    expect(t.exitEnd).toBe(sections[0]!.top);
    // the first section enters at the viewport bottom less than a section past the lineup
    expect(sections[0]!.top - 800 - t.rl).toBeLessThan(t.section);
  });

  it('the rise, Return and Last follow from the measured sections, and the wrap at Last', () => {
    expect(t.rise).toEqual({ start: 9720, end: 11000 });
    expect(t.ret).toEqual({ start: 11000, end: 12000 });
    expect(t.lastTop).toBe(12000);
    expect(wrapTarget(11990, 12030, t.lastTop)).toBe(30);
    expect(wrapTarget(11900, 11990, t.lastTop)).toBeNull();
  });

  it('the free span still has a trimmed middle, with a quarter viewport kept at each end', () => {
    expect(lapTrim(8199, t, 800)).toBe(false);
    expect(lapTrim(8200, t, 800)).toBe(true);
    expect(lapTrim(9519, t, 800)).toBe(true);
    expect(lapTrim(9520, t, 800)).toBe(false);
  });

  it('flowPosition is the inverse of flowAt over the whole page', () => {
    for (let y = 0; y <= 12400; y += 50)
      expect(flowPosition(flowAt(y, t), t)).toBeCloseTo(y, 6);
  });

  it('the first free frame keeps its place in the first section across a re-measure', () => {
    const a = freeAnchor(t.exitEnd + 1, sections, 800);
    expect(a?.i).toBe(0);
    expect(freeAnchorY(a!, sections, 800)).toBeCloseTo(t.exitEnd + 1, 6);
  });
});

describe('stage flow: the free part kept across a re-measure (rotation)', () => {
  // sections in document scroll px: opening, the first section, the last section, Return, Last
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

describe('the detail band is written once', () => {
  it('the CSS band spacer is FLOW_DETAIL_SLOTS sections of FLOW_SECTION_PANELS panels', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/components/pack-flow/home-flow.module.css'),
      'utf8',
    );
    const band =
      /\[data-flow-spacer='band'\]\s*\{\s*height:\s*calc\(var\(--panel\)\s*\*\s*([\d.]+)\s*\*\s*(\d+)\)/.exec(
        css,
      );
    expect(band).not.toBeNull();
    expect(Number(band?.[1])).toBe(FLOW_SECTION_PANELS);
    expect(Number(band?.[2])).toBe(FLOW_DETAIL_SLOTS);
  });
});

describe('stage flow: the end rests (the footer, the chosen pack, the row back)', () => {
  // a slim footer: 400 px, the last section
  const END = { riseSection: { top: 11600, bottom: 12000 } };

  it('the footer in view, the rise end, Last top: one rest each, ascending', () => {
    const t = table(END);
    // the footer's bottom at the viewport's bottom: 12000 - 800
    expect(t.rise).toEqual({ start: 11320, end: 12000 });
    expect(t.ends).toEqual([11200, 12000, 13000]);
  });

  it('freeFits: at the exit end (8000) only the last section is below the fold, or more of the page', () => {
    // the band to the footer rest (3200 px) is taller than the 400 px footer: Just Pulled runs below
    expect(table(END).freeFits).toBe(false);
    // the band 8000 to 8319 (319 px) is within the 800 px footer: only the footer is below
    expect(
      table({
        riseSection: { top: 8600, bottom: 9400 },
        ret: { top: 9400, height: 1000 },
        last: { top: 10400, height: 801 },
      }).freeFits,
    ).toBe(true);
    // the footer rest is the footer's top - 400 here: the band at a footer top of 8800 is
    // exactly the footer's height (fits); a pixel lower it is not
    const at = (top: number) =>
      table({
        riseSection: { top, bottom: top + 400 },
        ret: { top: top + 400, height: 1000 },
        last: { top: top + 1400, height: 801 },
      });
    expect(at(8800).ends[0]! - at(8800).exitEnd).toBe(400);
    expect(at(8800).freeFits).toBe(true);
    expect(at(8801).freeFits).toBe(false);
    // no end rests (no last section measured): false
    expect(table({ riseSection: null }).freeFits).toBe(false);
  });

  it('the footer rest is measured against the height seen under the header and above the tab bar', () => {
    expect(table({ ...END, view: 700 }).ends).toEqual([11300, 12000, 13000]);
  });

  it('stays above the rise start (nothing rises over the footer at rest) and below the exit end', () => {
    // a footer taller than 0.65 of the viewport: the rest is one pixel above the rise
    const tall = table({ riseSection: { top: 11000, bottom: 12000 } });
    expect(tall.rise!.start).toBe(10720);
    expect(tall.ends[0]).toBe(10719);
    expect(flowAt(tall.ends[0]!, tall)).toMatchObject({ span: 'free' });
    // a page so short the footer is in view at the exit end
    const short = table({
      riseSection: { top: 8100, bottom: 8300 },
      ret: { top: 8300, height: 1000 },
      last: { top: 9300, height: 801 },
    });
    expect(short.ends[0]).toBe(8000);
  });

  it('the rests sit on whole pixels except the wrap line', () => {
    const t = table({
      riseSection: { top: 11600.4, bottom: 12000.4 },
      ret: { top: 12000.4, height: 1000 },
      last: { top: 13000.4, height: 801 },
    });
    expect(t.ends).toEqual([11200, 12000, 13000.4]);
    // half a pixel short of Return: rounded down, so the others stay out
    const half = table({
      riseSection: { top: 11600.5, bottom: 12000.5 },
      ret: { top: 12000.5, height: 1000 },
    });
    expect(half.ends[1]).toBe(12000);
    expect(flowAt(half.ends[1]!, half)).toMatchObject({ span: 'rise' });
  });

  it('none without a measured last section or without Last', () => {
    expect(table({ riseSection: null }).ends).toEqual([]);
    expect(table({ ...END, last: null }).ends).toEqual([]);
  });

  it('without Return the pack rest and the wrap line are one: the rests stay distinct', () => {
    const t = table({ ...END, ret: null, last: { top: 12000, height: 801 } });
    expect(t.ends).toEqual([11200, 12000]);
  });

  it('the chosen pack rests at the rise end: risen whole, the others not back yet', () => {
    const t = table(END);
    const at = flowAt(t.ends[1]!, t);
    expect(at).toEqual({ zone: 'free', span: 'ret', t: 0 });
    expect(lapAt(at, { rise: 1, ret: 0 }, false)).toEqual({
      rise: 1,
      ret: 0,
      free: false,
      trim: false,
    });
  });
});

describe('stage flow: where the plain page opens when the flow switches off', () => {
  // the flow-on page: Just Pulled at 8000 (3000 tall), the footer at 11000;
  // the plain page: the same sections at 900 and 3900
  const on = [
    { top: 8000, height: 3000 },
    { top: 11000, height: 400 },
  ];
  const plain = [
    { top: 900, height: 3000 },
    { top: 3900, height: 400 },
  ];

  it('from the paged part (the row, a stop, the lineup, its exit): the row', () => {
    for (const y of [0, 3000, 7000, 7999])
      expect(offPlace(y, 8000, 0, on, plain, 800)).toBe(0);
  });

  it('from Just Pulled or the end: the same share of the same section under the middle', () => {
    // 9100 + 400 = 9500 is half-way through Just Pulled: 900 + 1500 - 400
    expect(offPlace(9100, 8000, 0, on, plain, 800)).toBe(2000);
    // the footer under the middle
    expect(offPlace(10800, 8000, 0, on, plain, 800)).toBe(3700);
  });

  it('the place is read in the old viewport and set in the new one', () => {
    // the middle of an 800 px view half-way through Just Pulled; the plain
    // page's view is 400 px: the same point under its middle
    expect(offPlace(9100, 8000, 0, on, plain, 800, 400)).toBe(2200);
  });

  it('with no sections measured: the row', () => {
    expect(offPlace(9100, 8000, 0, [], plain, 800)).toBe(0);
  });
});
