import { describe, expect, it } from 'vitest';

import type {
  ComposeCtx,
  FocusCtx,
  Pose,
  StageLayout,
  StageState,
} from '../contract';
import { FOCUS_TERM } from '../stage-compose';
import { spreadAt } from '../stage-flow';
import { focusKeys } from '../stage-focus-keys';
import { poseAt, poseStep1, restState, stageOpacity } from '../stage-pose';
import { composeOpacity, composePose } from '../stage-pose-compose';
import { ciaoOpacity, ciaoPose } from '../stage-spin';
import { LEAN } from '../stage-spin-math';

// The end of the lap (full-flow plan 2.6, 2.7): the chosen pack rises from
// one panel below to the row's rest, the others slide back from 5 to 1 row
// steps and fade in, and the end of Return is the row at rest exactly, so
// the wrap to R0 shows no seam.

const SIZES = [
  {
    name: 'phone',
    desktop: false,
    l: { cx: 195, cy: 330, step: 180, artH: 352, artW: 190 } as StageLayout,
    panel: { w: 390, h: 710, anchorY: 330 / 710, viewH: 844 },
  },
  {
    name: 'desktop',
    desktop: true,
    l: { cx: 720, cy: 400, step: 330, artH: 560, artW: 300 } as StageLayout,
    panel: { w: 1440, h: 780, anchorY: 400 / 780, viewH: 900 },
  },
] as const;

const COUNT = 6;
const KEYS = [
  'dx',
  'dy',
  'z',
  'rotX',
  'rotY',
  'rotZ',
  'scale',
  'dim',
  'fx',
  'fy',
] as const;
const close = (a: Pose, b: Pose, digits = 9) => {
  for (const k of KEYS) expect(a[k], k).toBeCloseTo(b[k], digits);
};

function setup(s: (typeof SIZES)[number], chosen: number) {
  const keys = focusKeys('151', s.desktop, 'sleeve');
  const focus: FocusCtx = {
    index: chosen,
    anchorY: s.panel.anchorY,
    keys,
    panel: { w: s.panel.w, h: s.panel.h },
    backW: 0,
    fit: 1,
  };
  // everything the runtime passes while a pack is focused: the lap must
  // ignore the focus and the lineup terms
  const ctx: ComposeCtx = {
    spin: {
      count: COUNT,
      turn: 0,
      lean: LEAN,
      spinPose: ciaoPose,
      panel: s.panel,
      exit: 1,
    },
    spinOpacity: ciaoOpacity,
    compose: composePose,
    focus,
    focusTerm: FOCUS_TERM,
  };
  // live terms that are on at the row too: the idle bob and the pointer
  const live = { idle: 1.3, pointerX: 0.4, pointerY: -0.2 };
  const lap = (
    rise: number,
    ret: number,
    free = false,
    focused = true,
  ): StageState => ({
    ...restState(chosen),
    ...live,
    focus: focused ? keys.length : 0,
    lap: { rise, ret, free, trim: false },
  });
  const rest: StageState = { ...restState(chosen), ...live };
  return { keys, ctx, lap, rest };
}

for (const s of SIZES)
  for (const chosen of [0, 2, 5])
    describe(`the lap's end (${s.name}, chosen ${chosen})`, () => {
      const t = setup(s, chosen);
      const pose = (st: StageState, i: number) =>
        poseAt(st, i, s.l, s.desktop, false, t.ctx);
      const op = (st: StageState, i: number) =>
        composeOpacity(st, i, s.desktop, COUNT, t.ctx);

      it('the seam: the end of Return is the row at rest, pose and opacity, for every pack', () => {
        for (let i = 0; i < COUNT; i++) {
          close(
            pose(t.lap(1, 1), i),
            poseStep1(t.rest, i, s.l, s.desktop, false),
          );
          expect(op(t.lap(1, 1), i)).toBeCloseTo(
            stageOpacity(t.rest, i, s.desktop, COUNT),
            9,
          );
        }
      });

      it('the seam holds with no pack focused too', () => {
        for (let i = 0; i < COUNT; i++)
          close(
            pose(t.lap(1, 1, false, false), i),
            poseStep1(t.rest, i, s.l, s.desktop, false),
          );
      });

      it('the rise: the chosen pack from one panel below to its rest; nothing else drawn', () => {
        const rest = poseStep1(t.rest, chosen, s.l, s.desktop, false);
        const start = pose(t.lap(0, 0), chosen);
        expect(start.fy).toBeCloseTo(1, 9);
        close({ ...start, fy: 0 }, rest);
        close(pose(t.lap(1, 0), chosen), rest);
        // eased: a quarter of the way is less than a quarter risen
        expect(pose(t.lap(0.25, 0), chosen).fy).toBeGreaterThan(0.75);
        expect(op(t.lap(0.5, 0), chosen)).toBeCloseTo(
          stageOpacity(t.rest, chosen, s.desktop, COUNT),
          9,
        );
        for (let i = 0; i < COUNT; i++)
          if (i !== chosen) expect(op(t.lap(0.9, 0), i)).toBe(0);
      });

      it('the free span: nothing drawn', () => {
        for (let i = 0; i < COUNT; i++)
          expect(op(t.lap(0, 0, true), i)).toBe(0);
      });

      it('Return: the others slide in from 5 row steps to 1 and fade in with it', () => {
        const ret = 0.5;
        for (let i = 0; i < COUNT; i++) {
          if (i === chosen) continue;
          const rest = poseStep1(t.rest, i, s.l, s.desktop, false);
          const p = pose(t.lap(1, ret), i);
          const slot = (i - chosen) * s.l.step;
          expect(p.dx + slot).toBeCloseTo(spreadAt(ret) * (rest.dx + slot), 6);
          close({ ...p, dx: rest.dx }, rest);
          expect(op(t.lap(1, ret), i)).toBeCloseTo(
            ret * stageOpacity(t.rest, i, s.desktop, COUNT),
            9,
          );
        }
        // the chosen pack holds its rest through Return
        close(
          pose(t.lap(1, ret), chosen),
          poseStep1(t.rest, chosen, s.l, s.desktop, false),
        );
      });
    });
