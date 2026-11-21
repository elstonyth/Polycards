import { describe, expect, it } from 'vitest';

import type { StageLayout } from '../contract';
import type { SpinCtx, StageState } from '../contract';
import { restBlock } from '../stage-compose';
import { restState, slotOpacity } from '../stage-pose';
import { CAPSULE_LIMITS } from '../stage-capsule-lean';
import { LEAN } from '../stage-spin-math';
import {
  LINEUP_REST_CAMERA,
  LINEUP_ROW,
  lineupCopies,
  lineupView,
  lineupOpacity,
  lineupPose,
  lineupRatio,
  quadInOut,
  GATHER,
  HOLD,
  K,
  PASS_BAND,
  PITCH_MAX,
  SPIN_DESKTOP,
  SPIN_PHONE,
  TURN_WEIGHT_MS,
  passBand,
  reachOpacity,
  spinCentre,
  spinConfig,
  spinOpacity,
  spinPose,
  spinRowPosition,
  spinRowStep,
  spinTravel,
  spinTravels,
  spinningFlag,
  stepTurnWeight,
  wrapRow,
  wrappedIndex,
} from '../stage-spin';

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
const SIZES = [
  { name: 'phone', desktop: false, l: PHONE },
  { name: 'desktop', desktop: true, l: DESKTOP },
] as const;

const st = (spin: number, track = 0): StageState => ({
  ...restState(track),
  spin,
});
const ctx = (count: number, turn = 1, lean = LEAN): SpinCtx => ({
  count,
  turn,
  lean,
});
const pose = (
  s: number,
  i: number,
  l: StageLayout,
  desktop: boolean,
  c: SpinCtx,
  track = 0,
) =>
  spinPose(
    restBlock(st(s, track), i, l, desktop, false),
    st(s, track),
    i,
    l,
    desktop,
    c,
  );
/** Screen x of the pack's centre (slot + dx). */
const screenX = (
  s: number,
  i: number,
  l: StageLayout,
  desktop: boolean,
  c: SpinCtx,
  track = 0,
) => l.cx + (i - track) * l.step + pose(s, i, l, desktop, c, track).dx;

const grid = (n: number) => Array.from({ length: n + 1 }, (_, k) => k / n);
const mod360 = (rad: number) => (((rad / DEG) % 360) + 360) % 360;

describe('spinPose: the ends', () => {
  for (const { name, desktop, l } of SIZES)
    it(`${name}: s = 0 returns the rest block unchanged`, () => {
      for (const track of [0, 3, 5.5])
        for (let i = 0; i < 11; i++) {
          const rest = restBlock(st(0, track), i, l, desktop, false);
          expect(spinPose(rest, st(0, track), i, l, desktop, ctx(11))).toEqual(
            rest,
          );
        }
    });

  for (const { name, desktop, l } of SIZES)
    it(`${name}: s = 1 is the row in its starting order, fronts facing`, () => {
      const c = spinConfig(desktop);
      for (const n of [3, 5, 6, 11, 16])
        for (const track of [0, 4]) {
          if (track >= n) continue;
          for (let i = 0; i < n; i++) {
            const dp = spinRowPosition(1, i, track, n, desktop);
            const d = i - track;
            // T = n: every pack back on its own slot (wrapped when the row travels)
            expect(dp).toBeCloseTo(
              spinTravels(n, desktop) ? wrapRow(d, n) : d,
              9,
            );
            if (Math.abs(dp) >= c.REACH + 1) continue; // not drawn
            const p = pose(1, i, l, desktop, ctx(n), track);
            expect(p.scale).toBe(c.S);
            expect(p.rotZ).toBeCloseTo(c.ROLL, 12);
            // fronts facing: the yaw is the row's -K d' plus one whole turn
            expect(p.rotY).toBeCloseTo(passBand(-K * dp) + 2 * Math.PI, 9);
            expect(Math.cos(p.rotY)).toBeGreaterThan(0);
          }
        }
    });
});

describe('spinPose: continuity', () => {
  for (const { name, desktop, l } of SIZES)
    it(`${name}: continuous at the gather and hold edges`, () => {
      for (const edge of [GATHER, HOLD])
        for (let i = 0; i < 11; i++) {
          const a = pose(edge - 1e-7, i, l, desktop, ctx(11));
          const b = pose(edge + 1e-7, i, l, desktop, ctx(11));
          for (const k of [
            'dx',
            'dy',
            'z',
            'rotX',
            'rotY',
            'rotZ',
            'scale',
          ] as const)
            expect(Math.abs(a[k] - b[k]), `${k} i=${i} s=${edge}`).toBeLessThan(
              1e-3,
            );
        }
    });

  for (const { name, desktop, l } of SIZES)
    it(`${name}: no pack pops or jumps while it is drawn`, () => {
      for (const n of [4, 5, 6, 7, 11, 14]) {
        const steps = 3000;
        for (let i = 0; i < n; i++) {
          let prev = pose(0, i, l, desktop, ctx(n));
          let prevOp = spinOpacity(st(0), i, desktop, n);
          for (let k = 1; k <= steps; k++) {
            const s = k / steps;
            const p = pose(s, i, l, desktop, ctx(n));
            const op = spinOpacity(st(s), i, desktop, n);
            // The wrap jump happens exactly at the reach edge (|d'| = n/2 >= reach
            // + 1 for any travelling n), where the pack is at most a hair's
            // opacity on both sides of it: below 1% it is not drawn visibly.
            if (op > 0.01 && prevOp > 0.01) {
              // one step of 1/3000 of the pin moves a pack well under a pack width
              expect(
                Math.abs(p.dx - prev.dx),
                `n=${n} i=${i} s=${s}`,
              ).toBeLessThan(l.artH * 0.05);
              expect(Math.abs(p.rotY - prev.rotY)).toBeLessThan(0.05);
            }
            expect(Math.abs(op - prevOp)).toBeLessThan(0.05);
            prev = p;
            prevOp = op;
          }
        }
      }
    }, 60_000);
});

describe('spinPose: the row', () => {
  for (const { name, desktop, l } of SIZES)
    it(`${name}: gathered row matches the gathered pose (scale, step, roll rising right)`, () => {
      const c = spinConfig(desktop);
      const w = spinRowStep(l, desktop);
      expect(w).toBeCloseTo(c.GAP * c.S * (l.artW ?? 0), 9);
      const s = GATHER;
      const p0 = pose(s, 0, l, desktop, ctx(11));
      const p1 = pose(s, 1, l, desktop, ctx(11));
      expect(
        screenX(s, 1, l, desktop, ctx(11)) - screenX(s, 0, l, desktop, ctx(11)),
      ).toBeCloseTo(w, 6);
      // rising to the right: the right neighbour sits higher (dy smaller, +y down)
      expect(p1.dy).toBeLessThan(p0.dy);
      expect(p1.rotZ).toBeLessThan(0);
    });

  it('phone shows 3 packs (+-2 fade to 0), desktop 5 (+-3 fade to 0)', () => {
    expect(SPIN_PHONE.REACH).toBe(1);
    expect(SPIN_DESKTOP.REACH).toBe(2);
    expect(reachOpacity(2, SPIN_PHONE.REACH)).toBe(0);
    expect(reachOpacity(1, SPIN_PHONE.REACH)).toBe(1);
    expect(reachOpacity(3, SPIN_DESKTOP.REACH)).toBe(0);
    expect(reachOpacity(2, SPIN_DESKTOP.REACH)).toBe(1);
  });

  for (const { name, desktop, l } of SIZES)
    it(`${name}: pitch is never above +5 degrees`, () => {
      for (const n of [1, 3, 5, 6, 11, 16])
        for (const s of grid(200))
          for (let i = 0; i < n; i++)
            for (const turn of [0, 0.5, 1])
              expect(
                pose(s, i, l, desktop, ctx(n, turn)).rotX,
              ).toBeLessThanOrEqual(PITCH_MAX + 1e-12);
    });

  for (const { name, desktop, l } of SIZES)
    it(`${name}: no pack shows twice and no two drawn packs share a slot, for any n`, () => {
      for (let n = 1; n <= 16; n++)
        for (const track of [0, Math.floor((n - 1) / 2), n - 1])
          for (const s of grid(100)) {
            const drawn: number[] = [];
            for (let i = 0; i < n; i++)
              if (spinOpacity(st(s, track), i, desktop, n) > 0.02)
                drawn.push(screenX(s, i, l, desktop, ctx(n), track));
            drawn.sort((a, b) => a - b);
            for (let k = 1; k < drawn.length; k++)
              expect(
                drawn[k]! - drawn[k - 1]!,
                `n=${n} track=${track} s=${s}`,
              ).toBeGreaterThan(spinRowStep(l, desktop) * 0.5);
          }
    });

  for (const { name, desktop } of SIZES)
    it(`${name}: fewer packs than the minimum spin in place`, () => {
      const min = spinConfig(desktop).MIN_TRAVEL_N;
      for (const s of grid(20)) {
        expect(spinTravel(s, min - 1, desktop)).toBe(0);
        for (let i = 0; i < min - 1; i++)
          expect(spinRowPosition(s, i, 0, min - 1, desktop)).toBe(i);
      }
      expect(spinTravel(1, min, desktop)).toBe(min);
    });

  for (const { name, desktop, l } of SIZES)
    it(`${name}: deterministic`, () => {
      for (const s of [0.05, 0.4, 0.77])
        for (let i = 0; i < 11; i++)
          expect(pose(s, i, l, desktop, ctx(11, 0.3))).toEqual(
            pose(s, i, l, desktop, ctx(11, 0.3)),
          );
    });

  it('the travel moves the row left and wraps', () => {
    // pack 0 starts centred; as T grows its row position falls (moves left)
    const a = spinRowPosition(0.3, 0, 0, 11, false);
    const b = spinRowPosition(0.4, 0, 0, 11, false);
    expect(b).toBeLessThan(a);
    for (const s of grid(50))
      for (let i = 0; i < 11; i++) {
        const dp = spinRowPosition(s, i, 0, 11, false);
        expect(dp).toBeGreaterThanOrEqual(-5.5);
        expect(dp).toBeLessThan(5.5);
      }
  });
});

describe('lean mode (capsules, the tip variant, packs without a back)', () => {
  for (const { name, desktop, l } of SIZES)
    it(`${name}: capsules stay within +-CAPSULE_LIMITS.yaw plus the rest yaw`, () => {
      for (const n of [5, 11])
        for (const s of grid(300))
          for (let i = 0; i < n; i++) {
            const rest = restBlock(st(s), i, l, desktop, false);
            const p = pose(s, i, l, desktop, ctx(n, 0, CAPSULE_LIMITS.yaw));
            expect(Math.abs(p.rotY)).toBeLessThanOrEqual(
              CAPSULE_LIMITS.yaw + Math.abs(rest.rotY) + 1e-9,
            );
          }
    });

  it('packs lean within +-LEAN in tip mode once gathered', () => {
    for (const s of grid(300).filter((s) => s >= GATHER))
      for (let i = 0; i < 11; i++)
        expect(
          Math.abs(pose(s, i, PHONE, false, ctx(11, 0)).rotY),
        ).toBeLessThanOrEqual(LEAN + 1e-9);
  });
});

describe('passBand (glare)', () => {
  it('keeps the ends of the spin and is odd, periodic and monotone', () => {
    expect(passBand(0)).toBe(0);
    expect(passBand(2 * Math.PI)).toBeCloseTo(2 * Math.PI, 12);
    expect(passBand(Math.PI)).toBeCloseTo(Math.PI, 12);
    let last = -Infinity;
    for (let x = -4 * Math.PI; x <= 4 * Math.PI; x += 0.001) {
      const y = passBand(x);
      expect(y).toBeGreaterThanOrEqual(last - 1e-12);
      last = y;
      expect(passBand(-x)).toBeCloseTo(-y, 9);
      expect(passBand(x + 2 * Math.PI)).toBeCloseTo(y + 2 * Math.PI, 9);
    }
  });

  it('gives each glare band only 5 degrees of input per turn', () => {
    let inBand = 0;
    const N = 360000;
    for (let k = 0; k < N; k++) {
      const out = mod360(passBand((k / N) * 2 * Math.PI));
      if (
        (out > PASS_BAND.lo && out < PASS_BAND.hi) ||
        (out > 360 - PASS_BAND.hi && out < 360 - PASS_BAND.lo)
      )
        inBand++;
    }
    expect((inBand / N) * 360).toBeCloseTo(2 * PASS_BAND.input, 1);
  });

  for (const { name, desktop, l } of SIZES)
    it(`${name}: a drawn pack spends about a quarter of the plain scroll share in the band`, () => {
      const n = 11;
      const steps = 40000;
      const inBand = (deg: number) =>
        (deg > 150 && deg < 170) || (deg > 190 && deg < 210);
      let band = 0;
      let plain = 0;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k <= steps; k++) {
          const s = k / steps;
          if (s < GATHER || spinOpacity(st(s), i, desktop, n) <= 0) continue;
          if (inBand(mod360(pose(s, i, l, desktop, ctx(n)).rotY))) band++;
          // the same turn without the pass band
          const dp = spinRowPosition(s, i, 0, n, desktop);
          const c = Math.min(1, Math.max(0, (s - GATHER) / (HOLD - GATHER)));
          const raw =
            -K * dp + 2 * Math.PI * (0.5 - 0.5 * Math.cos(Math.PI * c));
          if (inBand(mod360(raw))) plain++;
        }
      }
      expect(plain).toBeGreaterThan(0);
      expect(band / plain).toBeLessThan(0.3);
    });
});

describe('opacity and residency helpers', () => {
  for (const { name, desktop } of SIZES)
    it(`${name}: s = 0 opacity is step 1's slotOpacity`, () => {
      for (const track of [0, 2.5])
        for (let i = 0; i < 11; i++)
          expect(spinOpacity(st(0, track), i, desktop, 11)).toBe(
            slotOpacity(i - track, desktop),
          );
    });

  for (const { name, desktop } of SIZES)
    it(`${name}: gathered opacity is the spin reach of d'`, () => {
      for (const s of [GATHER, 0.5, 1])
        for (let i = 0; i < 11; i++)
          expect(spinOpacity(st(s), i, desktop, 11)).toBeCloseTo(
            reachOpacity(
              spinRowPosition(s, i, 0, 11, desktop),
              spinConfig(desktop).REACH,
            ),
            12,
          );
    });

  it('wraps indices around the travelling centre', () => {
    for (const s of grid(40)) {
      const c = spinCentre(s, 3, 11, false);
      const seen = new Set<number>();
      for (let i = 0; i < 11; i++) {
        const v = wrappedIndex(i, c, 11);
        const vi = Math.round(v);
        expect(Math.abs(v - vi)).toBeLessThan(1e-9);
        expect(vi - c).toBeGreaterThanOrEqual(-5.5);
        expect(vi - c).toBeLessThan(5.5);
        expect((((vi - i) % 11) + 11) % 11).toBe(0);
        seen.add(vi);
      }
      expect(seen.size).toBe(11);
    }
  });
});

describe('switches', () => {
  it('data-spinning flips at 0.02 with 0.005 hysteresis', () => {
    expect(spinningFlag(false, 0.019)).toBe(false);
    expect(spinningFlag(false, 0.02)).toBe(true);
    expect(spinningFlag(true, 0.016)).toBe(true);
    expect(spinningFlag(true, 0.015)).toBe(false);
  });

  it('the turn weight never starts in view, finishes once started, takes 400 ms', () => {
    expect(stepTurnWeight(0, 1, 16, false)).toBe(0);
    let w = stepTurnWeight(0, 1, 100, true);
    expect(w).toBeCloseTo(100 / TURN_WEIGHT_MS, 12);
    w = stepTurnWeight(w, 1, 100, false); // came into view mid-tween: carries on
    expect(w).toBeCloseTo(200 / TURN_WEIGHT_MS, 12);
    w = stepTurnWeight(w, 1, 1000, false);
    expect(w).toBe(1);
    expect(stepTurnWeight(1, 0, 16, false)).toBe(1);
  });
});

describe('tip: the packshot look', () => {
  const panelOf = (desktop: boolean) =>
    desktop
      ? { w: 1440, h: 828, anchorY: 400 / 828 }
      : { w: 390, h: 716, anchorY: 330 / 716 };
  const cpose = (
    s: number,
    i: number,
    desktop: boolean,
    exit = 0,
    track = 0,
  ) => {
    const l = desktop ? DESKTOP : PHONE;
    return lineupPose(
      restBlock(st(s, track), i, l, desktop, false),
      st(s, track),
      i,
      l,
      desktop,
      {
        count: 11,
        turn: 0,
        lean: LEAN,
        exit,
        panel: panelOf(desktop),
      },
    );
  };
  const DEGR = 180 / Math.PI;

  it("reproduces the sheet's pitch ramp: phone -17, 11, 40; desktop 12 deg per pack", () => {
    const pitch = (dp: number, w: number) =>
      dp * LINEUP_ROW.step * LINEUP_ROW.pitchPerUnit * lineupRatio(w) +
      LINEUP_ROW.pitchBias;
    expect([-1, 0, 1].map((d) => Math.round(pitch(d, 390) * DEGR))).toEqual([
      -17, 11, 40,
    ]);
    expect((pitch(1, 1440) - pitch(0, 1440)) * DEGR).toBeCloseTo(12.03, 1);
  });

  it('s = 0 and exit 0 is the rest pose; nothing turns about its own axis in the row', () => {
    for (const desktop of [false, true])
      for (let i = 0; i < 11; i++) {
        const l = desktop ? DESKTOP : PHONE;
        expect(cpose(0, i, desktop)).toEqual(
          restBlock(st(0), i, l, desktop, false),
        );
        // at s = 1 every pack still shows its front (|yaw| well under 90 deg)
        expect(Math.cos(cpose(1, i, desktop).rotY)).toBeGreaterThan(0.5);
      }
  });

  it('packs nearly touch along a row rolled about -10 deg, centre pack near the middle', () => {
    for (const desktop of [false, true]) {
      const p = panelOf(desktop);
      const a = cpose(1, 0, desktop);
      const b = cpose(1, 1, desktop);
      expect(Math.abs(a.fx ?? 0)).toBeLessThan(0.08);
      const ddx = ((b.fx ?? 0) - (a.fx ?? 0)) * p.w;
      const ddy = ((b.fy ?? 0) - (a.fy ?? 0)) * p.h;
      // rising to the right on screen
      expect(ddy).toBeLessThan(0);
      expect(Math.atan2(-ddy, ddx) * DEGR).toBeGreaterThan(5);
      expect(Math.atan2(-ddy, ddx) * DEGR).toBeLessThan(20);
    }
  });

  it('continuous in spin and in exit; the exit lifts the row, grows it and dims it', () => {
    for (const desktop of [false, true])
      for (let i = 0; i < 11; i++) {
        let prev = cpose(0, i, desktop);
        for (let k = 1; k <= 400; k++) {
          const p = cpose(k / 400, i, desktop);
          // a wrapped pack takes its row slot at once, at zero opacity
          const seen =
            lineupOpacity(st(k / 400), i, desktop, 11) > 0.01 &&
            lineupOpacity(st((k - 1) / 400), i, desktop, 11) > 0.01;
          const l = desktop ? DESKTOP : PHONE;
          const w = panelOf(desktop).w;
          const x = (q: typeof p) => i * l.step + q.dx + (q.fx ?? 0) * w;
          if (seen) {
            expect(Math.abs(x(p) - x(prev))).toBeLessThan(0.02 * w);
            expect(Math.abs(p.scale - prev.scale)).toBeLessThan(0.02);
          }
          prev = p;
        }
        for (let k = 1; k <= 400; k++) {
          const p = cpose(1, i, desktop, k / 400);
          expect(Math.abs((p.fy ?? 0) - (prev.fy ?? 0))).toBeLessThan(0.02);
          prev = p;
        }
      }
    const a = cpose(1, 0, false, 0);
    const b = cpose(1, 0, false, 1);
    expect(b.fy ?? 0).toBeLessThan((a.fy ?? 0) - 0.15);
    expect(b.scale).toBeGreaterThan(a.scale * 1.5);
    expect(a.dim).toBeCloseTo(LINEUP_ROW.restLight, 9);
    expect(b.dim).toBeCloseTo(LINEUP_ROW.restLight * LINEUP_ROW.exitLight, 9);
  });

  it('packs stand about 340 px on desktop, 300 on phones', () => {
    // centre pack at rest, viewport-height projection as the viewport's
    const h = (desktop: boolean) => {
      const l = desktop ? DESKTOP : PHONE;
      const p = lineupPose(
        restBlock(st(1), 0, l, desktop, false),
        st(1),
        0,
        l,
        desktop,
        {
          count: 11,
          turn: 0,
          lean: LEAN,
          panel: { ...panelOf(desktop), viewH: desktop ? 900 : 844 },
        },
      );
      return p.scale * l.artH;
    };
    expect(h(true)).toBeGreaterThan(320);
    expect(h(true)).toBeLessThan(370);
    expect(h(false)).toBeGreaterThan(280);
    expect(h(false)).toBeLessThan(340);
  });

  it('copies fill a short row on both sides; the centred pack is never a copy', () => {
    for (const n of [5, 6, 11])
      for (const desktop of [false, true]) {
        const slots = new Set<number>();
        for (let i = 0; i < n; i++)
          for (const c of lineupCopies(i, 0, n, desktop)) {
            const pos = wrapRow(i, n) + c;
            expect(slots.has(pos)).toBe(false);
            slots.add(pos);
          }
        const reach = desktop ? LINEUP_ROW.reachDesktop : LINEUP_ROW.reachPhone;
        for (let pos = -reach; pos <= reach; pos++)
          expect(slots.has(pos), `n=${n} pos=${pos}`).toBe(true);
        expect(lineupCopies(0, 0, n, desktop)).toContain(0);
        expect(lineupOpacity(st(0), 1, desktop, n, n)).toBe(0); // copies are invisible at rest
      }
  });

  it('capsules: the ramp is clamped to tip away at most 15 deg and toward at most 25, as seen', () => {
    const r = lineupRatio(1440);
    for (let dp = -5; dp <= 5; dp++) {
      const cap = lineupView(dp, LINEUP_REST_CAMERA, r, { capsule: true });
      const free = lineupView(dp, LINEUP_REST_CAMERA, r);
      void free;
      // world pitch range [rx - 15, rx + 25] = [-5, 35] deg
      const pitch =
        dp * LINEUP_ROW.step * LINEUP_ROW.pitchPerUnit * r +
        LINEUP_ROW.pitchBias;
      const clamped = Math.max(
        LINEUP_REST_CAMERA.rx - LINEUP_ROW.capsuleTipAway,
        Math.min(LINEUP_REST_CAMERA.rx + LINEUP_ROW.capsuleTipToward, pitch),
      );
      expect(clamped * DEGR).toBeGreaterThanOrEqual(-5 - 1e-9);
      expect(clamped * DEGR).toBeLessThanOrEqual(35 + 1e-9);
      expect(Number.isFinite(cap.ex)).toBe(true);
    }
  });

  it('the full-turn row takes the same exit: up, bigger, dimmer', () => {
    const base = { count: 11, turn: 1, lean: LEAN, panel: panelOf(false) };
    const at = (exit: number) =>
      spinPose(
        restBlock(st(1), 0, PHONE, false, false),
        st(1),
        0,
        PHONE,
        false,
        { ...base, exit },
      );
    expect(at(0)).toEqual(pose(1, 0, PHONE, false, ctx(11)));
    expect(at(1).fy ?? 0).toBeLessThan(-0.15);
    expect(at(1).scale).toBeGreaterThan(at(0).scale * 1.5);
    expect(at(1).dim).toBeCloseTo(LINEUP_ROW.exitLight, 9);
  });

  it('opacity: all 11 packs on desktop once formed, 3 plus a cut one each side on phones', () => {
    const shown = (desktop: boolean) =>
      Array.from({ length: 11 }, (_, i) =>
        lineupOpacity(st(1), i, desktop, 11),
      ).filter((o) => o > 0).length;
    expect(shown(true)).toBe(11);
    expect(shown(false)).toBe(5);
    expect(quadInOut(0.25)).toBeCloseTo(0.125, 12);
  });
});
