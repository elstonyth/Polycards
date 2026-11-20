import { describe, expect, it } from 'vitest';

import { cubicBezier } from '@/components/loader/loader-timeline';

import type { StageLayout } from '../contract';
import type { FocusCtx, StageStop } from '../contract';
import { restBlock } from '../stage-compose';
import {
  DESKTOP_YAW_BEATS,
  FOCUS_DESKTOP,
  FOCUS_PHONE,
  FOCUS_PITCH_MAX,
  FOCUS_REST_YAW_MAX,
  FOCUS_SOLD_OUT_DIM,
  TURN_BEZIER,
  TURN_MS,
  canStartFocus,
  clampFocusExtraYaw,
  focusDwell,
  focusMax,
  focusOpacity,
  focusPose,
  focusTarget,
  followFocus,
  spinWhileFocused,
  stopKindAt,
  turnFor,
  yawBeatFor,
} from '../stage-focus';
import { restState } from '../stage-pose';

const DEG = Math.PI / 180;
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

const stops = (...kinds: StageStop['kind'][]): StageStop[] =>
  kinds.map((kind, k) => ({ y: 1000 + k * 600, kind }));
const FULL = stops('back', 'tier', 'tier', 'tier', 'odds');

const ctxFor = (
  l: StageLayout,
  s: StageStop[] | null,
  extra: Partial<FocusCtx> = {},
): FocusCtx => ({
  index: 0,
  anchorY: l.cy / (l === PHONE ? 716 : 828),
  stops: s,
  ...extra,
});

const at = (
  f: number,
  turn: number,
  i: number,
  l: StageLayout,
  desktop: boolean,
  c: FocusCtx,
  soldOut = false,
) =>
  focusPose(
    restBlock(restState(0), i, l, desktop, soldOut),
    f,
    turn,
    i,
    0,
    l,
    desktop,
    soldOut,
    c,
  );

describe('focusTarget and the dwell', () => {
  it('maps scroll to 1 + piecewise linear over the stops, clamped', () => {
    expect(focusTarget(0, FULL)).toBe(1);
    expect(focusTarget(-50, FULL)).toBe(1);
    expect(focusTarget(1000, FULL)).toBe(1);
    expect(focusTarget(1300, FULL)).toBeCloseTo(1.5, 12);
    expect(focusTarget(1600, FULL)).toBeCloseTo(2, 12);
    expect(focusTarget(3400, FULL)).toBe(5);
    expect(focusTarget(99999, FULL)).toBe(5);
    expect(focusMax(FULL)).toBe(5);
  });

  it('copes with any number of stops (skipped tiers), 1 to 5', () => {
    for (let n = 1; n <= 5; n++) {
      const s = stops(
        'back',
        ...Array.from({ length: n - 1 }, () => 'tier' as const),
      );
      expect(focusMax(s)).toBe(n);
      expect(focusTarget(1e9, s)).toBe(n);
      let last = 0;
      for (let y = 0; y < 5000; y += 10) {
        const f = focusTarget(y, s);
        expect(f).toBeGreaterThanOrEqual(last);
        last = f;
      }
    }
    expect(focusMax(null)).toBe(1);
    expect(focusTarget(500, null)).toBe(1);
  });

  it('holds 20% of each unit still at both ends; the tween passes through', () => {
    expect(focusDwell(0.4)).toBe(0.4);
    expect(focusDwell(1)).toBe(1);
    expect(focusDwell(2.15)).toBe(2);
    expect(focusDwell(2.85)).toBe(3);
    expect(focusDwell(2.5)).toBeCloseTo(2.5, 12);
  });

  it('follows the target with a 90 ms damped follow', () => {
    expect(followFocus(1, 2, 90)).toBeCloseTo(1 + (1 - Math.exp(-1)), 9);
    expect(followFocus(1, 2, 0)).toBe(1);
    expect(followFocus(1.99995, 2, 16)).toBe(2);
  });
});

describe('turnFor (section 2)', () => {
  const ok = { canTurn: true, backReady: true };

  it('phone: back only at the back stop, flips at 1.5 with +-0.08 hysteresis', () => {
    expect(turnFor(0.3, FULL, false, 0, ok)).toBe(1); // during the focus tween
    expect(turnFor(1, FULL, false, 0, ok)).toBe(1);
    expect(turnFor(1.55, FULL, false, 1, ok)).toBe(1); // inside the band: keep
    expect(turnFor(1.45, FULL, false, 0, ok)).toBe(0); // inside the band: keep
    expect(turnFor(1.6, FULL, false, 1, ok)).toBe(0);
    expect(turnFor(1.4, FULL, false, 0, ok)).toBe(1);
    expect(turnFor(5, FULL, false, 0, ok)).toBe(0); // the phone does not turn at Odds
  });

  it('desktop: back at the back stop and at the Odds stop', () => {
    expect(turnFor(1, FULL, true, 0, ok)).toBe(1);
    expect(turnFor(3, FULL, true, 1, ok)).toBe(0);
    expect(turnFor(5, FULL, true, 0, ok)).toBe(1);
    expect(turnFor(4.55, FULL, true, 0, ok)).toBe(0); // hysteresis
    expect(turnFor(4.6, FULL, true, 0, ok)).toBe(1);
  });

  it('never turns without canTurn (capsules, no pull odds), a ready back, or while leaving', () => {
    for (const f of [0.5, 1, 5])
      for (const desktop of [false, true]) {
        expect(
          turnFor(f, FULL, desktop, 1, { canTurn: false, backReady: true }),
        ).toBe(0);
        expect(
          turnFor(f, FULL, desktop, 1, { canTurn: true, backReady: false }),
        ).toBe(0);
        expect(turnFor(f, FULL, desktop, 1, { ...ok, leaving: true })).toBe(0);
      }
    expect(turnFor(0, FULL, false, 1, ok)).toBe(0);
  });

  it('skips a missing tier without an empty stop', () => {
    const s = stops('back', 'tier', 'odds');
    expect(stopKindAt(3, s)).toBe('odds');
    expect(turnFor(3, s, true, 0, ok)).toBe(1);
    expect(turnFor(2, s, true, 1, ok)).toBe(0);
  });
});

describe('yaw beats (desktop, timed)', () => {
  it('beats -6, 0, +6 degrees by tier order; none on phones or other stops', () => {
    expect(yawBeatFor(2, FULL, true, 0)).toBe(DESKTOP_YAW_BEATS[0]);
    expect(yawBeatFor(3, FULL, true, 0)).toBe(DESKTOP_YAW_BEATS[1]);
    expect(yawBeatFor(4, FULL, true, 0)).toBe(DESKTOP_YAW_BEATS[2]);
    expect(yawBeatFor(1, FULL, true, 0)).toBe(0);
    expect(yawBeatFor(5, FULL, true, 0)).toBe(0);
    expect(yawBeatFor(3, FULL, false, 0)).toBe(0);
    expect(yawBeatFor(2.5, FULL, true, 0.1)).toBe(0.1); // at the boundary: keep
  });
});

describe('spin and focus are exclusive (10.4)', () => {
  it('focus starts only below 0.02, value and target', () => {
    expect(canStartFocus(0, 0)).toBe(true);
    expect(canStartFocus(0.019, 0.01)).toBe(true);
    expect(canStartFocus(0.02, 0)).toBe(false);
    expect(canStartFocus(0, 0.5)).toBe(false);
    expect(spinWhileFocused(0.3, 0.4)).toBe(0);
    expect(spinWhileFocused(0, 0.4)).toBe(0.4);
  });
});

describe('focusPose', () => {
  it('f = 0 is the rest pose', () => {
    for (const [l, desktop] of [
      [PHONE, false],
      [DESKTOP, true],
    ] as const)
      for (let i = 0; i < 4; i++) {
        const p = at(0, 0, i, l, desktop, ctxFor(l, FULL));
        expect(p).toEqual({
          ...restBlock(restState(0), i, l, desktop, false),
          fx: 0,
          fy: 0,
        });
      }
  });

  it('phone: the pack rises to the panel centre at 1.15, then docks at 0.3', () => {
    const c = ctxFor(PHONE, FULL);
    const p1 = at(1, 0, 0, PHONE, false, c);
    expect(p1.scale).toBeCloseTo(FOCUS_PHONE.back.scale, 12);
    expect(p1.fx).toBeCloseTo(0, 12);
    expect(p1.fy).toBeCloseTo(FOCUS_PHONE.back.y - c.anchorY, 12);
    const p2 = at(2, 0, 0, PHONE, false, c);
    expect(p2.scale).toBeCloseTo(FOCUS_PHONE.dock.scale, 12);
    expect(p2.fx).toBeCloseTo(FOCUS_PHONE.dock.x - 0.5, 12);
    expect(at(4, 0, 0, PHONE, false, c)).toEqual(p2);
  });

  it('desktop: the pack moves to the left column at 1.1 and stays there', () => {
    const c = ctxFor(DESKTOP, FULL);
    const p1 = at(1, 0, 0, DESKTOP, true, c);
    expect(p1.scale).toBeCloseTo(FOCUS_DESKTOP.back.scale, 12);
    expect(p1.fx).toBeCloseTo(-0.2, 12);
    expect(at(3, 0, 0, DESKTOP, true, c)).toEqual(p1);
  });

  it('neighbours slide off sideways, sink and are gone by f = 0.6', () => {
    const c = ctxFor(PHONE, FULL);
    const right = at(1, 0, 1, PHONE, false, { ...c, index: 0 });
    const left = at(1, 0, 0, PHONE, false, { ...c, index: 1 });
    expect(right.fx).toBeGreaterThan(0.5);
    expect(left.fx).toBeLessThan(-0.5);
    expect(right.dy).toBeGreaterThan(
      restBlock(restState(0), 1, PHONE, false, false).dy,
    );
    expect(focusOpacity(0.6, false)).toBe(0);
    expect(focusOpacity(0.3, false)).toBeGreaterThan(0);
    expect(focusOpacity(0.6, true)).toBe(1);
  });

  it('turn adds pi; pitch at most +5 degrees', () => {
    const c = ctxFor(PHONE, FULL);
    expect(at(1, 1, 0, PHONE, false, c).rotY).toBeCloseTo(Math.PI, 12);
    for (const f of [0.2, 0.6, 1, 2.5])
      for (const t of [0, 0.5, 1])
        expect(at(f, t, 0, PHONE, false, c).rotX).toBeLessThanOrEqual(
          FOCUS_PITCH_MAX,
        );
  });

  it('sold out: the focused pack eases from 0.4 to 0.75', () => {
    const c = ctxFor(PHONE, FULL);
    expect(at(0, 0, 0, PHONE, false, c, true).dim).toBeCloseTo(0.4, 12);
    expect(at(1, 0, 0, PHONE, false, c, true).dim).toBeCloseTo(
      FOCUS_SOLD_OUT_DIM,
      12,
    );
  });

  it('returning from a chapter: the pose does not jump when focus is set to 1', () => {
    const c = ctxFor(PHONE, FULL);
    const docked = at(3, 0, 0, PHONE, false, c);
    const jumped = at(1, 0, 0, PHONE, false, { ...c, leaveFrom: 3 });
    expect(jumped).toEqual(docked);
    // and lands on the rest pose at 0
    expect(at(0, 0, 0, PHONE, false, { ...c, leaveFrom: 3 })).toEqual(
      at(0, 0, 0, PHONE, false, c),
    );
  });
});

describe('no rest inside the glare band (decision 9c)', () => {
  it('extra yaw is clamped so a face at rest is at most 5 degrees off square', () => {
    expect(clampFocusExtraYaw(10 * DEG, 1)).toBeCloseTo(FOCUS_REST_YAW_MAX, 12);
    expect(clampFocusExtraYaw(-10 * DEG, 0.5)).toBeCloseTo(
      -FOCUS_REST_YAW_MAX,
      12,
    );
    expect(clampFocusExtraYaw(10 * DEG, 0)).toBeCloseTo(10 * DEG, 12);
    // back at rest: 175..185, outside the 150..170 test band
    expect(180 - FOCUS_REST_YAW_MAX / DEG).toBeGreaterThanOrEqual(175);
  });

  it('the timed turn crosses 150..170 degrees in well under 100 ms', () => {
    const ease = cubicBezier(...TURN_BEZIER);
    let inBand = 0;
    const steps = 6500;
    for (let k = 0; k <= steps; k++) {
      const deg = 180 * ease(k / steps);
      if (deg >= 150 && deg <= 170) inBand++;
    }
    const ms = (inBand / steps) * TURN_MS;
    expect(ms).toBeLessThan(100);
  });
});
