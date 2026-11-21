import { describe, expect, it } from 'vitest';

import type {
  ComposeCtx,
  FocusCtx,
  StageLayout,
  StageState,
} from '../contract';
import { FOCUS_TERM } from '../stage-compose';
import { focusKeys } from '../stage-focus-keys';
import { poseAt, restState } from '../stage-pose';
import { composeOpacity, composePose } from '../stage-pose-compose';
import { ciaoCopies, ciaoOpacity, ciaoPose } from '../stage-spin';
import { LEAN } from '../stage-spin-math';

// The endless pick (work package 5) moves the row's track while the focused
// pack's lineup is at rest. The track is handed to the row kept inside
// [-0.5, n - 0.5), so whenever it wraps by n the picture must not change.

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

const COUNT = 7;
const CHOSEN = 2;

function setup(s: (typeof SIZES)[number]) {
  const keys = focusKeys('151', s.desktop, 'sleeve');
  const focus: FocusCtx = {
    index: CHOSEN,
    anchorY: s.panel.anchorY,
    keys,
    panel: { w: s.panel.w, h: s.panel.h },
    backW: 1,
    fit: 1,
  };
  const ctx = (copy = 0): ComposeCtx => ({
    spin: {
      count: COUNT,
      turn: 0,
      lean: LEAN,
      spinPose: ciaoPose,
      panel: s.panel,
      copy,
    },
    spinOpacity: ciaoOpacity,
    compose: composePose,
    focus,
    focusTerm: FOCUS_TERM,
  });
  /** Resting on the lineup (the hand-off done) with the row at `track`. */
  const st = (track: number): StageState => ({
    ...restState(track),
    focus: keys.length,
    spin: 1,
    exit: 0,
  });
  /** Where pack i is drawn, as the canvas and the tiles add it up. */
  const drawn = (track: number, i: number, copy = 0) => {
    const p = poseAt(st(track), i, s.l, s.desktop, false, ctx(copy));
    return {
      x: (i - track) * s.l.step + p.dx + p.fx * s.panel.w,
      y: p.dy + p.fy * s.panel.h,
      z: p.z,
      rotX: p.rotX,
      rotY: p.rotY,
      rotZ: p.rotZ,
      scale: p.scale,
      dim: p.dim,
      op: composeOpacity(st(track), i, s.desktop, COUNT, ctx(copy), copy),
    };
  };
  return { drawn, st, ctx };
}

describe('the lineup repeats every n packs (the wrap is never seen)', () => {
  for (const s of SIZES) {
    it(`${s.name}: every pack and repeat is drawn the same at track t and t + n`, () => {
      const { drawn } = setup(s);
      for (const t of [2, 2.4, -0.3, 6.45]) {
        for (let i = 0; i < COUNT; i++) {
          const ca = ciaoCopies(i, t, COUNT, s.desktop);
          const cb = ciaoCopies(i, t + COUNT, COUNT, s.desktop);
          expect(cb).toEqual(ca);
          for (const c of ca) {
            const a = drawn(t, i, c);
            const b = drawn(t + COUNT, i, c);
            for (const k of Object.keys(a) as (keyof typeof a)[])
              expect(b[k]).toBeCloseTo(a[k], 6);
          }
        }
      }
    });
  }
});

describe('the focused pack, once the lineup has moved', () => {
  for (const s of SIZES) {
    it(`${s.name}: fades at the row's reach like any pack, not held whole`, () => {
      const { st, ctx } = setup(s);
      // dragged three packs on: the focused pack is three slots off centre
      const track = CHOSEN + 3;
      const op = composeOpacity(st(track), CHOSEN, s.desktop, COUNT, ctx());
      const row = ciaoOpacity(st(track), CHOSEN, s.desktop, COUNT);
      expect(op).toBeCloseTo(row, 6);
    });

    it(`${s.name}: still whole when it is the centred pack (the hand-off as built)`, () => {
      const { st, ctx } = setup(s);
      for (const spin of [0.1, 0.5, 1]) {
        const state = { ...st(CHOSEN), spin };
        expect(
          composeOpacity(state, CHOSEN, s.desktop, COUNT, ctx()),
        ).toBeCloseTo(1, 6);
      }
    });
  }
});
