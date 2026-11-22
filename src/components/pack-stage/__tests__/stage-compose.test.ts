import { describe, expect, it } from 'vitest';

import type { ComposeCtx, Pose, StageLayout, StageState } from '../contract';
import { FOCUS_TERM } from '../stage-compose';
import { composePose, restBlock } from '../stage-pose-compose';
import { LEAN } from '../stage-spin-math';
import { poseAt, poseStep1, restState } from '../stage-pose';
import { lineupPose } from '../stage-spin';

const PHONE: StageLayout = {
  cx: 195,
  cy: 330,
  step: 180,
  artH: 352,
  artW: 190,
};
const DESKTOP: StageLayout = {
  cx: 720,
  cy: 400,
  step: 330,
  artH: 560,
  artW: 300,
};

/** `poseAt` with the focus term and the composition the runtime passes. */
function composed(
  st: Readonly<StageState>,
  i: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<ComposeCtx> = {},
): Pose {
  return poseAt(st, i, l, desktop, soldOut, {
    ...ctx,
    focusTerm: FOCUS_TERM,
    compose: composePose,
  });
}

const STATES: StageState[] = [
  restState(0),
  { ...restState(2), intro: 0.3 },
  { ...restState(1.4), swap: 0.6 },
  { ...restState(0), pointerX: 0.8, pointerY: -0.5 },
  { ...restState(3), idle: 2.2 },
  { ...restState(0), idle: 0.4, pointerX: -1, intro: 0.8, swap: 0.2 },
];

describe('the composed pose with no spin and no focus is step 1 exactly', () => {
  for (const [name, l, desktop] of [
    ['phone', PHONE, false],
    ['desktop', DESKTOP, true],
  ] as const)
    it(name, () => {
      for (const s of STATES)
        for (let i = 0; i < 6; i++)
          for (const soldOut of [false, true]) {
            const a = poseStep1(s, i, l, desktop, soldOut);
            const b = composed({ ...s, spin: 0 }, i, l, desktop, soldOut);
            expect(poseAt(s, i, l, desktop, soldOut)).toEqual(a);
            for (const k of [
              'dx',
              'dy',
              'z',
              'rotX',
              'rotY',
              'scale',
              'dim',
            ] as const)
              expect(b[k], `${k}`).toBeCloseTo(a[k], 12);
            expect(b.rotZ).toBe(0);
            expect(b.fx).toBe(0);
            expect(b.fy).toBe(0);
          }
    });
});

describe('the spin term in the composition', () => {
  it('is skipped without spinPose (CSS tiles before the idle import)', () => {
    const s: StageState = { ...restState(0), spin: 0.5 };
    const p = composed(s, 1, PHONE, false, false, {
      spin: { count: 11, turn: 1, lean: LEAN },
    });
    const r = restBlock(s, 1, PHONE, false, false);
    expect(p.dx).toBeCloseTo(r.dx, 12);
    expect(p.rotZ).toBe(0);
  });

  // Spin and focus are no longer exclusive: while a
  // pack is focused the spin is the hand-off into the lineup
  // (stage-handoff.test.ts). With no hand-off the focus pose is alone.
  it('focused with no hand-off (spin 0), the row term is not drawn', () => {
    const s: StageState = { ...restState(0), spin: 0, focus: 0.5 };
    const p = composed(s, 1, PHONE, false, false, {
      spin: { count: 11, turn: 1, lean: LEAN, spinPose: lineupPose },
      focus: {
        index: 0,
        anchorY: 0.46,
        keys: [],
        panel: { w: 390, h: 716 },
      },
    });
    expect(p.rotZ).toBe(0);
  });
});
