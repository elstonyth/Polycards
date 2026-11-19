import { describe, expect, it } from 'vitest';

import type { StageLayout, StageState } from '../contract';
import {
  IDLE_SWAY_RAD,
  POINTER_LEAN_RAD,
  REST_POSE,
  labelIntro,
  poseAt,
  restState,
  slotIntro,
  slotOpacity,
  stageOpacity,
} from '../stage-pose';

const PHONE: StageLayout = { cx: 195, cy: 330, step: 210, artH: 352 };
const DESK: StageLayout = { cx: 720, cy: 430, step: 330, artH: 560 };
const DEG = Math.PI / 180;

function state(over: Partial<StageState> = {}): StageState {
  return { ...restState(4), ...over };
}

describe('poseAt: rest', () => {
  it('is the identity pose for the centred pack at rest', () => {
    for (const desktop of [false, true]) {
      const l = desktop ? DESK : PHONE;
      expect(poseAt(state(), 4, l, desktop, false)).toEqual(REST_POSE);
      // Fractional track positions too: centred means i === track.
      expect(poseAt(state({ track: 2.5 }), 2.5, l, desktop, false)).toEqual(
        REST_POSE,
      );
    }
  });

  it('places neighbours per the plan', () => {
    const s = state();
    const n1 = poseAt(s, 5, DESK, true, false);
    expect(n1.scale).toBeCloseTo(0.72);
    expect(n1.rotY).toBeCloseTo(-20 * DEG);
    expect(n1.dx).toBeCloseTo(0);
    expect(n1.dim).toBe(1);
    expect(n1.z).toBeLessThan(0);

    const n2 = poseAt(s, 6, DESK, true, false);
    expect(n2.scale).toBeCloseTo(0.55);
    expect(n2.rotY).toBeCloseTo(-28 * DEG);
    // +-2 sits about 560 px out when +-1 is 330 px out.
    expect(2 * DESK.step + n2.dx).toBeCloseTo(560);
    expect(n2.dim).toBeLessThan(1);

    // Phones never dim by distance.
    expect(poseAt(s, 6, PHONE, false, false).dim).toBe(1);
  });

  it('keeps far packs moving outward (no pile-up past the table)', () => {
    const s = state();
    let prev = -Infinity;
    for (let d = 0; d <= 8; d += 0.25) {
      const x = d * DESK.step + poseAt(s, 4 + d, DESK, true, false).dx;
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it('shares the visibility rule: phone +-1, desktop +-2, fading one slot beyond', () => {
    expect(slotOpacity(0, false)).toBe(1);
    expect(slotOpacity(1, false)).toBe(1);
    expect(slotOpacity(-1.5, false)).toBe(0.5);
    expect(slotOpacity(2, false)).toBe(0);
    expect(slotOpacity(2, true)).toBe(1);
    expect(slotOpacity(-3, true)).toBe(0);
  });

  it('fades whole packs with reach and the category switch', () => {
    expect(stageOpacity(state(), 4, false)).toBe(1);
    expect(stageOpacity(state(), 6, false)).toBe(0);
    expect(stageOpacity(state({ track: 4 }), 5.5, false)).toBe(0.5);
    expect(stageOpacity(state({ swap: 1 }), 4, true)).toBe(0);
    const half = stageOpacity(state({ swap: 0.3 }), 4, true);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.7); // eased: fades faster than linear
  });

  it('turns neighbours toward the centre', () => {
    const s = state();
    expect(poseAt(s, 5, PHONE, false, false).rotY).toBeLessThan(0); // right side faces left
    expect(poseAt(s, 3, PHONE, false, false).rotY).toBeGreaterThan(0);
  });
});

describe('poseAt: float-in', () => {
  it('starts low, set back, tilted back and turned', () => {
    const p = poseAt(state({ intro: 0 }), 4, PHONE, false, false);
    expect(p.dy).toBeGreaterThan(0.5 * PHONE.artH);
    expect(p.z).toBeLessThan(0);
    expect(p.rotX).toBeCloseTo(0.5);
    expect(Math.abs(p.rotY)).toBeCloseTo(0.6);
  });

  it('is monotone in intro for every slot', () => {
    for (const i of [4, 5, 3, 6, 2, 9]) {
      let prev = poseAt(state({ intro: 0 }), i, DESK, true, false);
      for (let k = 1; k <= 200; k++) {
        const p = poseAt(state({ intro: k / 200 }), i, DESK, true, false);
        expect(p.dy).toBeLessThanOrEqual(prev.dy + 1e-9);
        expect(p.z).toBeGreaterThanOrEqual(prev.z - 1e-9);
        expect(p.rotX).toBeLessThanOrEqual(prev.rotX + 1e-9);
        prev = p;
      }
      expect(prev).toEqual(poseAt(state(), i, DESK, true, false));
    }
  });

  it('is staggered outward from the centre', () => {
    for (const intro of [0.1, 0.3, 0.5, 0.7]) {
      const c = slotIntro(intro, 0);
      const n1 = slotIntro(intro, 1);
      const n2 = slotIntro(intro, -2);
      expect(c).toBeGreaterThan(n1);
      expect(n1).toBeGreaterThan(n2);
      expect(slotIntro(intro, 1)).toBe(slotIntro(intro, -1));
    }
    // Centre starts at once, the first neighbour 90 ms later (intro 1 = 1100 ms).
    expect(slotIntro(0.05, 0)).toBeGreaterThan(0);
    expect(slotIntro(80 / 1100, 1)).toBe(0);
    expect(slotIntro(100 / 1100, 1)).toBeGreaterThan(0);
  });

  it('finishes every slot, however far out, at intro = 1', () => {
    for (const d of [0, 1, 2, 3, 4, 7, 20]) {
      expect(slotIntro(1, d)).toBe(1);
      expect(labelIntro(1, d)).toBe(1);
    }
  });

  it('fades labels in after their pack', () => {
    expect(labelIntro(100 / 1100, 0)).toBe(0);
    expect(labelIntro(200 / 1100, 0)).toBeGreaterThan(0);
    expect(slotIntro(200 / 1100, 0)).toBeGreaterThan(labelIntro(200 / 1100, 0));
  });
});

describe('poseAt: symmetry and determinism', () => {
  it('mirrors left and right (yaw and dx antisymmetric, the rest equal)', () => {
    for (const desktop of [false, true]) {
      const l = desktop ? DESK : PHONE;
      for (const intro of [0.2, 0.6, 1]) {
        for (const d of [0.3, 1, 1.5, 2, 3.7]) {
          const s = state({ intro, track: 5 });
          const r = poseAt(s, 5 + d, l, desktop, false);
          const lft = poseAt(s, 5 - d, l, desktop, false);
          expect(lft.rotY).toBeCloseTo(-r.rotY, 12);
          expect(lft.dx).toBeCloseTo(-r.dx, 9);
          expect(lft.dy).toBeCloseTo(r.dy, 9);
          expect(lft.z).toBeCloseTo(r.z, 9);
          expect(lft.rotX).toBeCloseTo(r.rotX, 12);
          expect(lft.scale).toBeCloseTo(r.scale, 12);
          expect(lft.dim).toBeCloseTo(r.dim, 12);
        }
      }
    }
  });

  it('is linear in the layout: dx in steps, dy and z in art heights, cx/cy unused', () => {
    const unit: StageLayout = { cx: 0, cy: 0, step: 1, artH: 1 };
    const s = state({
      intro: 0.4,
      swap: 0.3,
      idle: 2.2,
      pointerX: 0.4,
      track: 3.6,
    });
    for (const i of [2, 3, 4, 5, 6]) {
      const u = poseAt(s, i, unit, true, false);
      const p = poseAt(s, i, DESK, true, false);
      expect(p.dx).toBeCloseTo(u.dx * DESK.step, 9);
      expect(p.dy).toBeCloseTo(u.dy * DESK.artH, 9);
      expect(p.z).toBeCloseTo(u.z * DESK.artH, 9);
      expect({ ...p, dx: 0, dy: 0, z: 0 }).toEqual({
        ...u,
        dx: 0,
        dy: 0,
        z: 0,
      });
    }
  });

  it('gives the same pose for the same state, and never mutates it', () => {
    const s = Object.freeze(
      state({
        intro: 0.37,
        track: 3.4,
        swap: 0.2,
        pointerX: 0.5,
        pointerY: -0.3,
        idle: 4.2,
      }),
    );
    for (const i of [0, 3, 4, 7]) {
      const a = poseAt(s, i, DESK, true, i === 7);
      const b = poseAt({ ...s }, i, DESK, true, i === 7);
      expect(a).toEqual(b);
    }
  });
});

describe('poseAt: swap, pointer, idle, sold out', () => {
  it('sinks with swap and is back in place at 0', () => {
    const down = poseAt(state({ swap: 1 }), 4, PHONE, false, false);
    expect(down.dy).toBeGreaterThan(0);
    expect(down.z).toBeLessThan(0);
    const half = poseAt(state({ swap: 0.5 }), 4, PHONE, false, false);
    expect(half.dy).toBeGreaterThan(0);
    expect(half.dy).toBeLessThan(down.dy);
    expect(poseAt(state({ swap: 0 }), 4, PHONE, false, false)).toEqual(
      REST_POSE,
    );
  });

  it('leans the centred pack up to 5 degrees toward the pointer, neighbours not at all', () => {
    const p = poseAt(
      state({ pointerX: 1, pointerY: -1 }),
      4,
      DESK,
      true,
      false,
    );
    expect(p.rotY).toBeCloseTo(POINTER_LEAN_RAD); // pointer right: face turns right
    expect(p.rotX).toBeCloseTo(POINTER_LEAN_RAD); // pointer above: top tips away (face up)
    const n = poseAt(state({ pointerX: 1, pointerY: 1 }), 5, DESK, true, false);
    expect(n).toEqual(poseAt(state(), 5, DESK, true, false));
  });

  it('bobs (all) and sways (desktop only), at rest on every 3 s', () => {
    const phone = poseAt(state({ idle: 0.75 + 3 }), 4, PHONE, false, false);
    expect(phone.dy).not.toBe(0);
    expect(phone.rotY).toBe(0);
    const desk = poseAt(state({ idle: 1.5 }), 4, DESK, true, false);
    expect(Math.abs(desk.rotY)).toBeCloseTo(IDLE_SWAY_RAD);
    for (const t of [3, 6, 9, 600]) {
      const r = poseAt(state({ idle: t }), 4, DESK, true, false);
      expect(r.dy).toBeCloseTo(0, 9);
      expect(r.rotY).toBeCloseTo(0, 9);
    }
    // Bob amplitude is small: about 2 px on the phone.
    for (let t = 0; t < 6; t += 0.05) {
      expect(
        Math.abs(poseAt(state({ idle: t }), 4, PHONE, false, false).dy),
      ).toBeLessThan(3);
    }
  });

  it('dims sold-out packs to 0.4', () => {
    const s = state();
    for (const i of [4, 5, 6]) {
      const live = poseAt(s, i, DESK, true, false);
      const sold = poseAt(s, i, DESK, true, true);
      expect(sold.dim).toBeCloseTo(live.dim * 0.4);
      expect({ ...sold, dim: 0 }).toEqual({ ...live, dim: 0 });
    }
  });

  it('ignores focus and turn for now (step 2)', () => {
    expect(poseAt(state({ focus: 1, turn: 1 }), 4, DESK, true, false)).toEqual(
      REST_POSE,
    );
  });
});
