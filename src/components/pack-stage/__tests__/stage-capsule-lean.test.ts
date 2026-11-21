/**
 * The 3D capsule's lean (owner, 2026-11-20, "Small leans only"): whatever the
 * stage poses (the row at rest with the pointer at its extremes and the idle
 * sway, the paged spin, its exit, the row's repeats, every focus stop and
 * every move between them, on both sizes), the lean the runtime hands the
 * capsule stays within +-CAPSULE_LIMITS.yaw of yaw and tips away at most
 * `capsuleTipAway`, toward at most `capsuleTipToward`. Limits, never values.
 */
import { describe, expect, it } from 'vitest';

import type {
  ComposeCtx,
  FocusCtx,
  StageLayout,
  StageState,
} from '../contract';
import {
  CAPSULE_LIMITS,
  capsuleLean,
  capsulePose,
} from '../stage-capsule-lean';
import { tileVars } from '../StageTile';
import { FOCUS_TERM } from '../stage-compose';
import { focusKeys } from '../stage-focus-keys';
import { poseAt, restState } from '../stage-pose';
import { composePose } from '../stage-pose-compose';
import {
  LINEUP_ROW,
  lineupCopies,
  lineupOpacity,
  lineupPose,
} from '../stage-spin';

const SIZES = [
  {
    desktop: false,
    l: { cx: 195, cy: 330, step: 180, artH: 352, artW: 190 } as StageLayout,
    panel: { w: 390, h: 716, anchorY: 0.46, viewH: 844 },
  },
  {
    desktop: true,
    l: { cx: 720, cy: 400, step: 330, artH: 560, artW: 300 } as StageLayout,
    panel: { w: 1440, h: 831, anchorY: 0.48, viewH: 900 },
  },
];
const N = 5;
const EPS = 1e-9;

function within(p: { rotX: number; rotY: number }, what: string) {
  const { yaw, rotX } = capsuleLean(p);
  expect(Math.abs(yaw), `${what} yaw`).toBeLessThanOrEqual(
    CAPSULE_LIMITS.yaw + EPS,
  );
  expect(rotX, `${what} tip away`).toBeLessThanOrEqual(
    CAPSULE_LIMITS.tipAway + EPS,
  );
  expect(-rotX, `${what} tip toward`).toBeLessThanOrEqual(
    CAPSULE_LIMITS.tipToward + EPS,
  );
}

describe('capsule lean limits', () => {
  it('the limits are the owner rulings', () => {
    expect(CAPSULE_LIMITS.yaw).toBeCloseTo((25 * Math.PI) / 180, 12);
    expect(CAPSULE_LIMITS.tipAway).toBe(LINEUP_ROW.capsuleTipAway);
    expect(CAPSULE_LIMITS.tipToward).toBe(LINEUP_ROW.capsuleTipToward);
    expect(CAPSULE_LIMITS.tipAway).toBeLessThanOrEqual(CAPSULE_LIMITS.yaw);
  });

  it('clamps any pose, and leaves a lean inside the limits as it is', () => {
    for (const v of [-10, -1, -0.3, 0, 0.2, 0.9, 10, Number.NaN]) {
      within({ rotX: v, rotY: v }, `v=${v}`);
      within({ rotX: -v, rotY: v * 3 }, `v=${v}`);
    }
    const inside = {
      rotX: CAPSULE_LIMITS.tipAway / 2,
      rotY: -CAPSULE_LIMITS.yaw / 2,
    };
    expect(capsuleLean(inside)).toEqual({
      yaw: inside.rotY,
      rotX: inside.rotX,
    });
  });

  for (const { desktop, l, panel } of SIZES) {
    const name = desktop ? 'desktop' : 'phone';
    const spinCtx = (exit: number, copy = 0): ComposeCtx => ({
      spin: {
        count: N,
        turn: 0,
        lean: CAPSULE_LIMITS.yaw,
        spinPose: lineupPose,
        exit,
        panel,
        capsule: true,
        copy,
      },
      spinOpacity: lineupOpacity,
      compose: composePose,
    });

    it(`${name}: the row at rest, the pointer and the idle sway`, () => {
      for (let i = 0; i < N; i++)
        for (const px of [-1, 0, 1])
          for (const py of [-1, 0, 1])
            for (const idle of [0, 0.5, 1, 1.7, 3.2]) {
              const s: StageState = {
                ...restState(2),
                pointerX: px,
                pointerY: py,
                idle,
              };
              within(
                poseAt(s, i, l, desktop, false, spinCtx(0)),
                `rest i=${i} p=${px},${py} idle=${idle}`,
              );
            }
    });

    it(`${name}: the paged spin, its exit and the row's repeats`, () => {
      for (let track = 0; track < N; track++)
        for (let i = 0; i < N; i++)
          for (let k = 0; k <= 20; k++) {
            const spin = k / 20;
            for (const exit of spin === 1 ? [0, 0.25, 0.5, 0.75, 1] : [0]) {
              const s: StageState = { ...restState(track), spin, exit };
              for (const copy of lineupCopies(i, track, N, desktop))
                within(
                  poseAt(s, i, l, desktop, false, spinCtx(exit, copy)),
                  `spin=${spin} exit=${exit} i=${i} copy=${copy}`,
                );
            }
          }
    });

    it(`${name}: every focus stop of a capsule and every move between them`, () => {
      const keys = focusKeys('gold-capsule', desktop, 'capsule');
      const fctx: FocusCtx = {
        index: 2,
        anchorY: l.cy / panel.h,
        keys,
        panel: { w: panel.w, h: panel.h },
        fit: 1,
      };
      const last = keys.length;
      for (let f = 0; f <= last * 20; f++) {
        const focus = f / 20;
        for (const pointerX of [-1, 0, 1]) {
          const s: StageState = { ...restState(2), focus, pointerX };
          const ctx: ComposeCtx = {
            ...spinCtx(0),
            focus: fctx,
            focusTerm: FOCUS_TERM,
          };
          within(
            poseAt(s, 2, l, desktop, false, ctx),
            `focus=${focus} px=${pointerX}`,
          );
        }
      }
    });
  }

  // The CSS tiles: tileVars writes the row's rest pose (the server HTML
  // and every frame without the spin chunk), so a capsule's tile clamps there
  // too. Read back from the written vars (4 decimals, hence the tolerance).
  const CSS_EPS = 1e-4;
  const cssLean = (vars: Record<string, string>, p: 'm' | 'd') => ({
    rotX: Number(vars[`--${p}-rx`]),
    rotY: Number(vars[`--${p}-ry`]),
  });
  const cssWithin = (vars: Record<string, string>, what: string) => {
    for (const p of ['m', 'd'] as const) {
      const { rotX, rotY } = cssLean(vars, p);
      expect(Math.abs(rotY), `${what} ${p} yaw`).toBeLessThanOrEqual(
        CAPSULE_LIMITS.yaw + CSS_EPS,
      );
      expect(rotX, `${what} ${p} away`).toBeLessThanOrEqual(
        CAPSULE_LIMITS.tipAway + CSS_EPS,
      );
      expect(-rotX, `${what} ${p} toward`).toBeLessThanOrEqual(
        CAPSULE_LIMITS.tipToward + CSS_EPS,
      );
    }
  };

  it('CSS tiles: a capsule keeps the limits over the row at rest, every 0.01 of track', () => {
    for (let k = 0; k <= (N - 1) * 100; k++) {
      const track = k / 100;
      for (let i = 0; i < N; i++)
        for (const px of [-1, 0, 1])
          for (const py of [-1, 0, 1]) {
            const s: StageState = {
              ...restState(2),
              track,
              pointerX: px,
              pointerY: py,
            };
            cssWithin(
              tileVars(i, s, false, 0, true),
              `track=${track} i=${i} p=${px},${py}`,
            );
          }
    }
  });

  it('CSS tiles: sleeves stay as they are', () => {
    let turned = false;
    for (let k = 0; k <= (N - 1) * 20; k++)
      for (let i = 0; i < N; i++) {
        const s: StageState = { ...restState(2), track: k / 20, pointerX: 1 };
        const sleeve = tileVars(i, s, false, 0.3);
        expect(tileVars(i, s, false, 0.3, false)).toEqual(sleeve);
        // the rest table turns a sleeve's neighbours past the capsule limit
        if (Math.abs(cssLean(sleeve, 'd').rotY) > CAPSULE_LIMITS.yaw + 0.05)
          turned = true;
      }
    expect(turned).toBe(true);
  });

  it('a capsule has no Buyback: five stops, on both sizes', () => {
    for (const desktop of [false, true])
      expect(
        focusKeys('gold-capsule', desktop, 'capsule').map((k) => k.kind),
      ).toEqual(['front', 'tophits', 'odds', 'pulls', 'closing']);
  });

  it('capsulePose clamps a capsule and hands a sleeve its own pose', () => {
    const wide = { rotX: 1, rotY: -1, dx: 3 };
    expect(capsulePose(wide, false)).toBe(wide);
    expect(capsulePose(wide, true)).toEqual({
      rotX: CAPSULE_LIMITS.tipAway,
      rotY: -CAPSULE_LIMITS.yaw,
      dx: 3,
    });
  });
});
