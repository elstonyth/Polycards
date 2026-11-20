import { describe, expect, it } from 'vitest';

import type { StageLayout, StageState } from '../contract';
import { poseStep2, restBlock, stageOpacityStep2 } from '../stage-compose';
import { LEAN, introOpacity } from '../stage-spin-math';
import {
  poseAt,
  poseStep1,
  restState,
  slotOpacity,
  stageSpring,
} from '../stage-pose';
import { PITCH_MAX, spinOpacity, spinPose } from '../stage-spin';

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

const STATES: StageState[] = [
  restState(0),
  { ...restState(2), intro: 0.3 },
  { ...restState(1.4), swap: 0.6 },
  { ...restState(0), pointerX: 0.8, pointerY: -0.5 },
  { ...restState(3), idle: 2.2 },
  { ...restState(0), idle: 0.4, pointerX: -1, intro: 0.8, swap: 0.2 },
];

describe('poseStep2 with no spin and no focus is step 1 exactly', () => {
  for (const [name, l, desktop] of [
    ['phone', PHONE, false],
    ['desktop', DESKTOP, true],
  ] as const)
    it(name, () => {
      for (const s of STATES)
        for (let i = 0; i < 6; i++)
          for (const soldOut of [false, true]) {
            const a = poseStep1(s, i, l, desktop, soldOut);
            const b = poseStep2({ ...s, spin: 0 }, i, l, desktop, soldOut);
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
            expect(
              stageOpacityStep2({ ...s, spin: 0 }, i, desktop, 6),
            ).toBeCloseTo(
              slotOpacity(i - s.track, desktop) *
                (1 - stageSpring(Math.min(1, Math.max(0, s.swap)))) *
                introOpacity(s.intro, i - s.track),
              12,
            );
          }
    });
});

describe('the spin composes with the other terms', () => {
  const spin = { count: 11, turn: 1, lean: LEAN, spinPose };

  it('swap = 1 moves dy by the same amount at s = 0.5 as at s = 0', () => {
    for (const desktop of [false, true]) {
      const l = desktop ? DESKTOP : PHONE;
      for (let i = 0; i < 11; i++) {
        const at = (s: number, swap: number) =>
          poseStep2({ ...restState(0), swap, spin: s }, i, l, desktop, false, {
            spin,
          }).dy;
        expect(at(0.5, 1) - at(0.5, 0)).toBeCloseTo(at(0, 1) - at(0, 0), 9);
      }
    }
  });

  it('the float-in composes at any spin (a reload mid-pin)', () => {
    const s: StageState = { ...restState(0), intro: 0, spin: 0.5 };
    const floated = poseStep2(s, 0, PHONE, false, false, { spin });
    const settled = poseStep2({ ...s, intro: 1 }, 0, PHONE, false, false, {
      spin,
    });
    expect(floated.dy).toBeGreaterThan(settled.dy);
    expect(stageOpacityStep2(s, 0, false, 11, { spin, spinOpacity })).toBe(0);
  });

  it('pitch stays at most +5 degrees with the pointer at its extremes (it fades with the gather)', () => {
    for (const py of [-1, 1])
      for (const s of [0.15, 0.5, 1])
        for (let i = 0; i < 11; i++) {
          const p = poseStep2(
            { ...restState(0), pointerY: py, pointerX: 1, spin: s },
            i,
            DESKTOP,
            true,
            false,
            { spin },
          );
          expect(p.rotX).toBeLessThanOrEqual(PITCH_MAX + 1e-12);
        }
  });

  it('the spin term is skipped without spinPose (CSS tiles before the idle import)', () => {
    const s: StageState = { ...restState(0), spin: 0.5 };
    const p = poseStep2(s, 1, PHONE, false, false, {
      spin: { count: 11, turn: 1, lean: LEAN },
    });
    const r = restBlock(s, 1, PHONE, false, false);
    expect(p.dx).toBeCloseTo(r.dx, 12);
    expect(p.rotZ).toBe(0);
  });

  it('the spin is ignored while focused (held at 0)', () => {
    const s: StageState = { ...restState(0), spin: 0.5, focus: 0.5 };
    const p = poseStep2(s, 1, PHONE, false, false, {
      spin,
      focus: { index: 0, anchorY: 0.46, stops: null },
    });
    expect(p.rotZ).toBe(0);
  });
});

describe('introOpacity (10.10)', () => {
  it('draws nothing at intro 0 and everything at intro 1', () => {
    for (const d of [-2, -1, 0, 1, 2]) {
      expect(introOpacity(0, d)).toBe(0);
      expect(introOpacity(1, d)).toBe(1);
    }
    expect(introOpacity(0.15, 0)).toBeGreaterThan(0);
    expect(introOpacity(0.15, 0)).toBeLessThan(1);
  });
});
