import { describe, expect, it } from 'vitest';

import { poseAt, restState, stageOpacity } from '../stage-pose';
import { composePose } from '../stage-pose-compose';
import { ciaoOpacity, ciaoPose } from '../stage-spin';
import {
  LEAN,
  SPIN_EXIT_PANELS,
  SPIN_PIN_PANELS,
  SPIN_TEXT_AT,
  spinFlags,
  spinRangeOf,
} from '../stage-spin-math';
import type { ComposeCtx, StageLayout } from '../contract';

const OFF = { spinning: false, text: false, head: false };

describe('the pin range', () => {
  it('starts where the panel sticks and is whole pixels', () => {
    const r = spinRangeOf(69.4, 69, 710.6);
    expect(r).toEqual({
      start: 0,
      length: Math.round(SPIN_PIN_PANELS * 710.6),
      exit: Math.round(SPIN_EXIT_PANELS * 710.6),
    });
    for (const v of Object.values(r ?? {}))
      expect(Number.isInteger(v)).toBe(true);
  });

  it('no panel, no range', () => {
    expect(spinRangeOf(0, 69, 0)).toBeNull();
  });
});

describe('the timed text flags', () => {
  it('lock at 0.02, text at 20% of the move, header as the exit starts', () => {
    expect(spinFlags(OFF, 0.019, 0)).toEqual(OFF);
    expect(spinFlags(OFF, 0.02, 0).spinning).toBe(true);
    expect(spinFlags(OFF, SPIN_TEXT_AT, 0).text).toBe(true);
    expect(spinFlags(OFF, 1, 0.009).head).toBe(false);
    expect(spinFlags(OFF, 1, 0.01).head).toBe(true);
  });

  it('holds with hysteresis so a settling value never flickers', () => {
    const on = { spinning: true, text: true, head: true };
    expect(spinFlags(on, 0.016, 0.006)).toEqual({
      spinning: true,
      text: false,
      head: true,
    });
    expect(spinFlags(on, 0.014, 0.004)).toEqual(OFF);
  });
});

describe('poseAt with the Ciao row injected', () => {
  const L: StageLayout = { cx: 195, cy: 330, step: 180, artH: 352, artW: 190 };
  const ctx: ComposeCtx = {
    spin: {
      count: 11,
      turn: 0,
      lean: LEAN,
      spinPose: ciaoPose,
      panel: { w: 390, h: 710, anchorY: 330 / 710, viewH: 844 },
    },
    spinOpacity: ciaoOpacity,
    compose: composePose,
  };

  it('is step 1 at spin 0 and without the composer', () => {
    for (let i = 0; i < 5; i++) {
      const st = restState(2);
      expect(poseAt(st, i, L, false, false, ctx)).toEqual(
        poseAt(st, i, L, false, false),
      );
      const half = { ...restState(2), spin: 0.5 };
      expect(
        poseAt(half, i, L, false, false, { ...ctx, compose: undefined }),
      ).toEqual(poseAt(half, i, L, false, false));
    }
  });

  it('forms the row: rolled, projected, and the row keeps its own fade', () => {
    const st = { ...restState(2), spin: 1 };
    const p = poseAt(st, 2, L, false, false, ctx);
    expect(p.rotZ).not.toBe(0);
    expect(p.fy).not.toBe(0);
    expect(stageOpacity(st, 2, false, 11, ctx)).toBeCloseTo(
      ciaoOpacity(st, 2, false, 11),
      12,
    );
  });
});
