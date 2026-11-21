import { describe, expect, it } from 'vitest';

import type {
  ComposeCtx,
  FocusCtx,
  Pose,
  StageLayout,
  StageState,
} from '../contract';
import { FOCUS_TERM } from '../stage-compose';
import { focusKeys } from '../stage-focus-keys';
import { poseAt, restState } from '../stage-pose';
import { composeOpacity, composePose } from '../stage-pose-compose';
import { ciaoOpacity, ciaoPose } from '../stage-spin';
import { LEAN } from '../stage-spin-math';
import {
  BACK_RELEASE_AT,
  focusBackWanted,
  LINEUP_APPEAR_MS,
  lineupAppear,
  lineupResident,
} from '../stage-flow';
import {
  GPU_CAP_DESKTOP_BYTES,
  GPU_CAP_PHONE_BYTES,
  textureBytes,
} from '../runtime/stage-residency';
import { drawingBufferBytes } from '../runtime/stage-scene';
import { CIAO_ROW } from '../stage-spin';

// The hand-off from Closing to the lineup (full-flow plan 2.4): while a pack
// is focused, st.spin is the local progress from Closing to the lineup rest
// and st.exit the lineup's exit. h = power1InOut(spin), applied once.

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

const COUNT = 11;
const CHOSEN = 2;
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

function setup(s: (typeof SIZES)[number]) {
  const keys = focusKeys('151', s.desktop, 'sleeve');
  const n = keys.length;
  const focus: FocusCtx = {
    index: CHOSEN,
    anchorY: s.panel.anchorY,
    keys,
    panel: { w: s.panel.w, h: s.panel.h },
    backW: 1,
    fit: 1,
  };
  const spin = {
    count: COUNT,
    turn: 0,
    lean: LEAN,
    spinPose: ciaoPose,
    panel: s.panel,
  };
  const ctx: ComposeCtx = {
    spin,
    spinOpacity: ciaoOpacity,
    compose: composePose,
    focus,
    focusTerm: FOCUS_TERM,
  };
  /** The row alone (no focus): the old spin path, the lineup's own pose. */
  const rowCtx = (exit = 0): ComposeCtx => ({
    spin: { ...spin, exit },
    spinOpacity: ciaoOpacity,
    compose: composePose,
  });
  const st = (spin: number, exit = 0): StageState => ({
    ...restState(CHOSEN),
    focus: n,
    spin,
    exit,
  });
  const at = (spin: number, i = CHOSEN, exit = 0, copy = 0): Pose =>
    poseAt(st(spin, exit), i, s.l, s.desktop, false, {
      ...ctx,
      spin: { ...ctx.spin!, exit, copy },
    });
  const closing = poseAt(
    { ...restState(CHOSEN), focus: n },
    CHOSEN,
    s.l,
    s.desktop,
    false,
    ctx,
  );
  const row = (i = CHOSEN, exit = 0, copy = 0): Pose =>
    poseAt({ ...restState(CHOSEN), spin: 1, exit }, i, s.l, s.desktop, false, {
      ...rowCtx(exit),
      spin: { ...rowCtx(exit).spin!, copy },
    });
  return { n, ctx, st, at, closing, row };
}

const close = (a: Pose, b: Pose, digits = 9) => {
  for (const k of KEYS) expect(a[k], k).toBeCloseTo(b[k], digits);
};

for (const s of SIZES)
  describe(`the hand-off from Closing to the lineup (${s.name})`, () => {
    const t = setup(s);

    it('at h = 0 the chosen pack is on its Closing key', () => {
      close(t.at(1e-9), t.closing, 6);
    });

    it('at h = 1 it is the lineup row at spin 1, exactly', () => {
      close(t.at(1), t.row());
    });

    it('the move follows power1InOut of the local progress, once', () => {
      // power1InOut(0.25) = 0.125 (eased twice it would be 0.03125)
      const mid = t.at(0.25);
      for (const k of ['dx', 'fx', 'fy', 'scale', 'rotZ'] as const)
        expect(mid[k], k).toBeCloseTo(
          t.closing[k] + (t.row()[k] - t.closing[k]) * 0.125,
          9,
        );
    });

    it('never turns: the chosen pack stays front-facing through the move', () => {
      for (let x = 0; x <= 1.0001; x += 0.01) {
        const p = t.at(Math.min(1, x));
        expect(Math.abs(p.rotY), `spin ${x}`).toBeLessThan(
          (30 * Math.PI) / 180,
        );
      }
    });

    it('the lineup exit is the row exit, the chosen pack included', () => {
      for (const exit of [0.3, 0.7, 1])
        for (const i of [CHOSEN, CHOSEN + 1, CHOSEN - 2])
          close(t.at(1, i, exit), t.row(i, exit));
    });

    it('the others close in from 5 row steps to 1 as h goes 0 to 1', () => {
      const gap = (spin: number) =>
        Math.abs(t.at(spin, CHOSEN + 1).fx - t.at(spin, CHOSEN).fx);
      const g1 = gap(1);
      expect(g1).toBeCloseTo(
        Math.abs(t.row(CHOSEN + 1).fx - t.row(CHOSEN).fx),
        9,
      );
      // h = 0.5 at spin 0.5: spacing 3 row steps
      expect(gap(0.5)).toBeGreaterThan(2 * g1);
      expect(gap(0.1)).toBeGreaterThan(gap(0.5));
      expect(gap(1e-6)).toBeGreaterThan(3.5 * g1);
    });

    it('the others fade in with h; the chosen pack stays whole', () => {
      const op = (spin: number, i: number, copy = 0) =>
        composeOpacity(t.st(spin), i, s.desktop, COUNT, t.ctx, copy);
      const rowOp = (i: number, copy = 0) =>
        ciaoOpacity(
          { ...restState(CHOSEN), spin: 1 },
          i,
          s.desktop,
          COUNT,
          copy,
        );
      for (const spin of [0, 0.25, 0.5, 1]) {
        expect(op(spin, CHOSEN)).toBe(1);
        const h = spin < 0.5 ? 2 * spin * spin : 1 - 2 * (1 - spin) ** 2;
        expect(op(spin, CHOSEN + 1)).toBeCloseTo(h * rowOp(CHOSEN + 1), 9);
        // a copy of the chosen pack is one of the others
        expect(op(spin, CHOSEN, COUNT)).toBeCloseTo(
          h * rowOp(CHOSEN, COUNT),
          9,
        );
      }
    });

    it('before the hand-off nothing changes: Closing as the focused view draws it', () => {
      const st0 = { ...restState(CHOSEN), focus: t.n };
      expect(composeOpacity(st0, CHOSEN + 1, s.desktop, COUNT, t.ctx)).toBe(0);
      expect(composeOpacity(st0, CHOSEN, s.desktop, COUNT, t.ctx)).toBe(1);
    });
  });

describe('the focused back at the hand-off (full-flow plan 2.12, risk 4)', () => {
  it('is wanted up to Closing + 0.5 and released past it', () => {
    expect(BACK_RELEASE_AT).toBe(0.5);
    expect(focusBackWanted(0)).toBe(true);
    expect(focusBackWanted(0.49)).toBe(true);
    expect(focusBackWanted(0.5)).toBe(false);
    expect(focusBackWanted(1)).toBe(false);
  });

  // 151's half picture (pack-3d manifest): the biggest half fronts are
  // about this size
  const HALF: [number, number] = [466, 833];
  const half = textureBytes(...HALF);
  /** The back printed from the full plate: twice the half each way. */
  const back = textureBytes(HALF[0] * 2, HALF[1] * 2);
  const ENV = 6e6;
  const cases = [
    {
      name: 'phone (DPR 2, 390x716 panel)',
      buffer: drawingBufferBytes(780, 1432, 0),
      reach: CIAO_ROW.reachPhone,
      cap: GPU_CAP_PHONE_BYTES,
    },
    {
      name: 'desktop (DPR 2, 1440x828 panel)',
      buffer: drawingBufferBytes(2880, 1656, 0),
      reach: CIAO_ROW.reachDesktop,
      cap: GPU_CAP_DESKTOP_BYTES,
    },
  ];
  for (const c of cases)
    it(`${c.name}: the lineup's fronts fit under the cap once the back is gone`, () => {
      // every pack within the row's reach plus the fading one, at half
      const packs = Math.min(11, 2 * (c.reach + 1) + 1);
      const lineup = c.buffer + ENV + packs * half;
      expect(lineup).toBeLessThan(c.cap);
      // before the release the back sits beside the Closing pack's front
      expect(c.buffer + ENV + half + back).toBeLessThan(c.cap);
    });
});

describe('the lineup is resident before the hand-off needs it', () => {
  // a front uploaded mid-move would pop in at the fade it has reached
  it('from the rest on Closing on, and through the hand-off and the exit', () => {
    expect(lineupResident({ focus: 6, stops: 6, spin: 0, exit: 0 })).toBe(true);
    expect(lineupResident({ focus: 6, stops: 6, spin: 0.4, exit: 0 })).toBe(
      true,
    );
    expect(lineupResident({ focus: 6, stops: 6, spin: 1, exit: 0.5 })).toBe(
      true,
    );
  });

  it('not at the other stops, nor at the row', () => {
    expect(lineupResident({ focus: 5, stops: 6, spin: 0, exit: 0 })).toBe(
      false,
    );
    expect(lineupResident({ focus: 5.5, stops: 6, spin: 0, exit: 0 })).toBe(
      false,
    );
    expect(lineupResident({ focus: 0, stops: 0, spin: 0, exit: 0 })).toBe(
      false,
    );
    // the row's own spin (no focus) keeps its own rule
    expect(lineupResident({ focus: 0, stops: 0, spin: 0.5, exit: 0 })).toBe(
      true,
    );
  });
});

describe('a lineup pack whose front arrives late fades in (never cuts in)', () => {
  it('rises from 0 to 1 over LINEUP_APPEAR_MS from the moment its front can be drawn', () => {
    expect(LINEUP_APPEAR_MS).toBe(300);
    expect(lineupAppear(0)).toBe(0);
    expect(lineupAppear(150)).toBeCloseTo(0.5, 9);
    expect(lineupAppear(300)).toBe(1);
    expect(lineupAppear(5000)).toBe(1);
  });

  it('a front drawable long before (the usual case, prefetched at Closing) is whole at once', () => {
    expect(lineupAppear(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
