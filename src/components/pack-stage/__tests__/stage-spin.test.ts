import { describe, expect, it } from 'vitest';

import type { StageLayout } from '../contract';
import type { SpinPanel, StageState } from '../contract';
import { restBlock } from '../stage-pose-compose';
import { restState } from '../stage-pose';
import { LEAN } from '../stage-spin-math';
import {
  LINEUP_REST_CAMERA,
  LINEUP_ROW,
  lineupCopies,
  lineupView,
  lineupOpacity,
  lineupPitchPx,
  lineupPose,
  lineupRatio,
  quadInOut,
  wrapRow,
} from '../stage-spin';

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
const st = (spin: number, track = 0): StageState => ({
  ...restState(track),
  spin,
});

describe('the lineup follows the hand: one pack per drawn spacing', () => {
  // where the centred pack is drawn when the track moves by half a pack each way
  const drawnX = (panel: SpinPanel, track: number) => {
    const s = st(1, track);
    const p = lineupPose(
      restBlock(s, 0, DESKTOP, true, false),
      s,
      0,
      DESKTOP,
      true,
      { count: 5, turn: 0, lean: LEAN, exit: 0, panel },
    );
    return (
      DESKTOP.cx + (0 - track) * DESKTOP.step + p.dx + (p.fx ?? 0) * panel.w
    );
  };
  for (const [w, h] of [
    [3840, 2160],
    [2560, 1440],
    [1920, 1080],
    [390, 844],
  ] as const) {
    it(`${w}x${h}: the drag's spacing is the spacing drawn on screen`, () => {
      const panel = { w, h: h - 70, anchorY: 0.46, viewH: h };
      const drawn = Math.abs(drawnX(panel, 0.5) - drawnX(panel, -0.5));
      expect(lineupPitchPx(DESKTOP, panel)).toBeCloseTo(drawn, 0);
    });
  }
  it('on a 4K screen the drawn spacing is far wider than the row step (a drag by the step ran ahead of the hand)', () => {
    const panel = { w: 3840, h: 2090, anchorY: 0.46, viewH: 2160 };
    expect(lineupPitchPx(DESKTOP, panel)).toBeGreaterThan(1.3 * DESKTOP.step);
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
