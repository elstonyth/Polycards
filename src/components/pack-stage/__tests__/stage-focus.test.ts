import { describe, expect, it } from 'vitest';

import type { FocusCtx, StageLayout } from '../contract';
import POSES from '../focus-poses.json';
import {
  blockAt,
  DESKTOP_BACK_LANE,
  fitBackKey,
  fitPhoneTextKey,
  phoneTextReserve,
  focusOpacity,
  focusPose,
  power1InOut,
  spotAt,
} from '../stage-focus';
import { focusKeys, focusStops } from '../stage-focus-keys';
import { restBlock } from '../stage-pose-compose';
import { restState } from '../stage-pose';

const DEG = Math.PI / 180;
const SLUGS = Object.keys(POSES.packs);
const PANELS = {
  phone: { w: 390, h: 710 },
  desktop: { w: 1440, h: 831 },
};
const LAYOUT: Record<'phone' | 'desktop', StageLayout> = {
  phone: { cx: 195, cy: 320, step: 180, artH: 352, artW: 190 },
  desktop: { cx: 720, cy: 395, step: 247, artH: 420, artW: 225 },
};

const ctxFor = (
  slug: string,
  desktop: boolean,
  variant: 'sleeve' | 'capsule' | 'noOdds' = 'sleeve',
): FocusCtx => {
  const size = desktop ? 'desktop' : 'phone';
  return {
    index: 2,
    anchorY: LAYOUT[size].cy / PANELS[size].h,
    keys: focusKeys(slug, desktop, variant),
    panel: PANELS[size],
  };
};

describe('focus keys (focus-poses.json)', () => {
  it('every stop of every pack lands where the table says', () => {
    for (const slug of SLUGS)
      for (const desktop of [false, true]) {
        const size = desktop ? 'desktop' : 'phone';
        const ctx = ctxFor(slug, desktop);
        const l = LAYOUT[size];
        const table = (POSES.packs as Record<string, Record<string, unknown>>)[
          slug
        ]![size] as Record<
          string,
          { cx: number; cy: number; long: number; rz: number; ry: number }
        >;
        ctx.keys.forEach((key, k) => {
          const p = focusPose(
            restBlock(restState(2), 2, l, desktop, false),
            k + 1,
            0,
            2,
            2,
            l,
            desktop,
            false,
            ctx,
          );
          const raw = table[key.kind]!;
          // a desktop back lies between the text column and the icons (fitBackKey)
          const want =
            desktop && key.face === 'back'
              ? { ...raw, ...fitBackKey(raw, PANELS[size].w, PANELS[size].h) }
              : !desktop && (key.kind === 'front' || key.kind === 'closing')
                ? {
                    ...raw,
                    ...fitPhoneTextKey(raw, PANELS[size].w, PANELS[size].h),
                  }
                : raw;
          // the centre the pose places, in panel fractions
          expect(l.cx / PANELS[size].w + p.fx).toBeCloseTo(want.cx, 6);
          expect(l.cy / PANELS[size].h + p.fy).toBeCloseTo(want.cy, 6);
          expect(p.scale * l.artH).toBeCloseTo(want.long * PANELS[size].h, 6);
          expect(p.rotZ).toBeCloseTo(want.rz * DEG, 6);
          expect(p.rotY).toBeCloseTo(want.ry * DEG, 6);
        });
      }
  });

  it('is deterministic', () => {
    const ctx = ctxFor('gold-pack', true);
    const l = LAYOUT.desktop;
    const at = () =>
      focusPose(
        restBlock(restState(2), 2, l, true, false),
        2.37,
        0,
        2,
        2,
        l,
        true,
        false,
        ctx,
      );
    expect(at()).toEqual(at());
  });

  it('a capsule and a pack with no pull odds never show a back', () => {
    for (const desktop of [false, true]) {
      for (const variant of ['capsule', 'noOdds'] as const) {
        const ctx = ctxFor('151', desktop, variant);
        expect(ctx.keys.every((k) => k.face === 'front' && k.on === 0)).toBe(
          true,
        );
        const l = LAYOUT[desktop ? 'desktop' : 'phone'];
        for (let f = 0; f <= ctx.keys.length; f += 0.05) {
          const p = focusPose(
            restBlock(restState(2), 2, l, desktop, false),
            f,
            0,
            2,
            2,
            l,
            desktop,
            false,
            ctx,
          );
          expect(Math.abs(p.rotY)).toBeLessThan(90 * DEG);
        }
      }
    }
    expect(focusStops('capsule')).toEqual([
      'front',
      'tophits',
      'odds',
      'pulls',
      'closing',
    ]);
    expect(focusStops('noOdds')).toEqual([
      'front',
      'tophits',
      'pulls',
      'closing',
    ]);
  });

  it('backs rest within 5 degrees of square, never in the 150..170 band', () => {
    for (const slug of SLUGS)
      for (const desktop of [false, true])
        for (const key of focusKeys(slug, desktop, 'sleeve')) {
          if (key.face === 'back')
            expect(Math.abs(key.ry - 180)).toBeLessThanOrEqual(5);
          const r = ((key.ry % 360) + 360) % 360;
          expect(r >= 150 && r <= 170).toBe(false);
        }
  });

  it('a back stop waits on its front until the back is uploaded', () => {
    const ctx = { ...ctxFor('151', false), backW: 0 };
    const l = LAYOUT.phone;
    const p = focusPose(
      restBlock(restState(2), 2, l, false, false),
      3,
      0,
      2,
      2,
      l,
      false,
      false,
      ctx,
    );
    expect(Math.abs(p.rotY)).toBeLessThanOrEqual(5 * DEG);
    expect(spotAt(3, ctx).on).toBe(0);
  });

  // the moves are a 1.5 s ease-out cubic: the tap's focus is ease(t), the
  // leave's 1 - ease(t), t the move's time fraction
  const ease = (t: number) => 1 - (1 - t) ** 3;
  const enter: FocusCtx = {
    index: 2,
    anchorY: 0.5,
    keys: [],
    panel: { w: 1, h: 1 },
    leaving: false,
  };
  const leave = { ...enter, leaving: true };
  const timeSpan = (op: (t: number) => number) => {
    // the time fractions where the neighbours are part-way (0 < op < 1)
    const ts: number[] = [];
    for (let i = 0; i <= 1000; i++) {
      const o = op(i / 1000);
      if (o > 0.001 && o < 0.999) ts.push(i / 1000);
    }
    return [ts[0] ?? NaN, ts.at(-1) ?? NaN] as const;
  };

  it('neighbours leave WITH the tap: a ramp over about the first 40% of the move', () => {
    const [a, b] = timeSpan((t) => focusOpacity(ease(t), false, enter));
    expect(a).toBeLessThanOrEqual(0.02);
    expect(b).toBeGreaterThanOrEqual(0.33);
    expect(b).toBeLessThanOrEqual(0.47);
    // and they are gone for the rest of the focus, the focused pack never fades
    for (let f = ease(0.47); f <= 6; f += 0.05) {
      expect(focusOpacity(f, false, enter), String(f)).toBe(0);
      expect(focusOpacity(f, true, enter)).toBe(1);
    }
    // at 60 fps no frame drops them by more than a tenth
    for (let i = 1; i <= 90; i++)
      expect(
        focusOpacity(ease((i - 1) / 90), false, enter) -
          focusOpacity(ease(i / 90), false, enter),
      ).toBeLessThanOrEqual(0.1);
  });

  it('neighbours come back with the leave: on screen before the pack has made 90% of its change of size, fully back just after it lands', () => {
    const op = (t: number) => focusOpacity(1 - ease(t), false, leave);
    for (const desktop of [false, true]) {
      const size = desktop ? 'desktop' : 'phone';
      const l = LAYOUT[size];
      const panel = PANELS[size];
      const ctx = { ...ctxFor('151', desktop), leaving: true };
      const pose = (i: number, t: number) =>
        focusPose(
          restBlock(restState(2), i, l, desktop, false),
          1 - ease(t),
          0,
          i,
          2,
          l,
          desktop,
          false,
          ctx,
        );
      // the focused pack's scale along the leave (its real pose, Front to row)
      const s0 = pose(2, 0).scale;
      const s1 = pose(2, 1).scale;
      const done = (t: number) =>
        Math.abs(pose(2, t).scale - s0) / Math.abs(s1 - s0);
      // the right-hand neighbour's width inside the panel, in px
      const inside = (t: number) => {
        const p = pose(3, t);
        const c = l.cx + p.dx + p.fx * panel.w;
        const hw = ((l.artW ?? 0) * p.scale) / 2;
        return Math.max(0, Math.min(panel.w, c + hw) - Math.max(0, c - hw));
      };
      const ts = Array.from({ length: 1001 }, (_, i) => i / 1000);
      const at90 = ts.find((t) => done(t) >= 0.9)!;
      const landed = ts.find((t) => done(t) >= 0.99)!;
      // seen: 16 px or more of it inside the panel, at a fifth opacity or more
      const seen = ts.find((t) => inside(t) >= 16 && op(t) >= 0.2)!;
      const firstDrawn = ts.find((t) => op(t) > 0.001)!;
      const fullyBack = ts.find((t) => op(t) >= 0.99)!;
      expect(inside(1), size + ' on screen at rest').toBeGreaterThan(16);
      expect(seen, size + ' seen').toBeLessThanOrEqual(at90);
      // within 150 ms of the 1.5 s move after the pack lands
      expect(
        fullyBack - landed,
        size + ' back after landing',
      ).toBeLessThanOrEqual(0.1);
      // still a ramp of 450 ms or more
      expect(fullyBack - firstDrawn, size + ' ramp').toBeGreaterThanOrEqual(
        0.3,
      );
    }
    // nothing for the first 250 ms of the move (the stop's text is still
    // fading when a gesture pages back past Front), fully back at the row
    for (let t = 0; t <= 0.16; t += 0.01) expect(op(t), String(t)).toBe(0);
    expect(op(1)).toBe(1);
    // at 60 fps no frame brings them back by more than a tenth
    for (let i = 1; i <= 90; i++)
      expect(op(i / 90) - op((i - 1) / 90)).toBeLessThanOrEqual(0.1);
  });

  it('neighbours slide out, sink and set back as they fade, and back again', () => {
    const l = LAYOUT.phone;
    const pose = (f: number, c: typeof enter) =>
      focusPose(
        restBlock(restState(2), 3, l, false, false),
        f,
        0,
        3,
        2,
        l,
        false,
        false,
        { ...ctxFor('151', false), ...c, keys: ctxFor('151', false).keys },
      );
    // half-way through their fade they are part-way out
    const mid = pose(ease(0.2), enter);
    expect(mid.fx).toBeGreaterThan(0.1);
    expect(mid.fx).toBeLessThan(0.55);
    expect(pose(1, enter).fx).toBeGreaterThan(0.5);
    // never in front of their row place (they set back)
    expect(mid.z).toBeLessThanOrEqual(
      restBlock(restState(2), 3, l, false, false).z,
    );
    // leaving, still out until the last part
    expect(pose(1 - ease(0.2), leave).fx).toBeGreaterThan(0.5);
  });

  it('neighbours slide off', () => {
    const ctx = ctxFor('151', false);
    const l = LAYOUT.phone;
    const p = focusPose(
      restBlock(restState(2), 3, l, false, false),
      1,
      0,
      3,
      2,
      l,
      false,
      false,
      ctx,
    );
    expect(p.fx).toBeGreaterThan(0.5);
  });
});

describe('owner correction (2026-11-20): upright fronts, the back on its side', () => {
  it('every front-facing stop is upright; backs lie level (roll 90)', () => {
    for (const slug of SLUGS)
      for (const desktop of [false, true]) {
        for (const key of focusKeys(slug, desktop, 'sleeve')) {
          if (key.face === 'front') {
            expect([key.rz, key.ry, key.rx]).toEqual([0, 0, 0]);
          } else {
            expect(key.rz).toBe(90);
            expect(key.rx).toBe(0);
          }
        }
        for (const key of focusKeys(slug, desktop, 'noOdds'))
          expect([key.rz, key.ry, key.rx]).toEqual([0, 0, 0]);
        for (const key of focusKeys(slug, desktop, 'capsule'))
          expect([key.rz, key.rx]).toEqual([0, 0]);
      }
  });

  it('the lane: front-facing stops keep the Front size and centre x', () => {
    for (const slug of SLUGS)
      for (const desktop of [false, true])
        for (const variant of ['sleeve', 'noOdds'] as const) {
          const keys = focusKeys(slug, desktop, variant);
          const front = keys.find((k) => k.kind === 'front')!;
          for (const key of keys) {
            if (key.face !== 'front') continue;
            expect(key.long).toBe(front.long);
            expect(key.cx).toBe(front.cx);
            const raised =
              !desktop && (key.kind === 'tophits' || key.kind === 'pulls');
            // phone Top Hits and Recent Pulls: centre on the panel's top edge
            expect(key.cy).toBe(raised ? 0 : front.cy);
          }
        }
  });

  it('Front to Top Hits is a pure vertical slide', () => {
    for (const desktop of [false, true]) {
      const size = desktop ? 'desktop' : 'phone';
      const l = LAYOUT[size];
      const ctx = ctxFor('151', desktop);
      const rest = restBlock(restState(2), 2, l, desktop, false);
      const a = focusPose(rest, 1, 0, 2, 2, l, desktop, false, ctx);
      for (let f = 1; f <= 2.0001; f += 0.1) {
        const p = focusPose(rest, f, 0, 2, 2, l, desktop, false, ctx);
        expect(p.scale).toBeCloseTo(a.scale, 9);
        expect(p.fx).toBeCloseTo(a.fx, 9);
        expect(p.rotZ).toBeCloseTo(0, 12);
        expect(p.rotY).toBeCloseTo(0, 12);
      }
    }
  });

  it('the tap is a pure zoom: no rotation anywhere in the move', () => {
    for (const desktop of [false, true]) {
      const size = desktop ? 'desktop' : 'phone';
      const l = LAYOUT[size];
      const ctx = ctxFor('151', desktop);
      const rest = restBlock(restState(2), 2, l, desktop, false);
      for (let f = 0; f <= 1.0001; f += 0.05) {
        const p = focusPose(rest, f, 0, 2, 2, l, desktop, false, ctx);
        expect(p.rotX).toBeCloseTo(0, 9);
        expect(p.rotY).toBeCloseTo(0, 9);
        expect(p.rotZ).toBeCloseTo(0, 9);
      }
    }
  });

  it('Top Hits to Pull Odds: it turns over first, then lies down; size never pops', () => {
    for (const desktop of [false, true]) {
      const size = desktop ? 'desktop' : 'phone';
      const l = LAYOUT[size];
      const ctx = ctxFor('151', desktop);
      const rest = restBlock(restState(2), 2, l, desktop, false);
      let prev = focusPose(rest, 2, 0, 2, 2, l, desktop, false, ctx);
      const turnAt = (q: number) => q / 176;
      for (let f = 2.02; f <= 3.0001; f += 0.02) {
        const p = focusPose(rest, f, 0, 2, 2, l, desktop, false, ctx);
        const x = f - 2;
        // the turn leads the roll through the first part of the move
        if (x < 0.35) expect(p.rotZ).toBeCloseTo(0, 9);
        if (x > 0.65) expect(turnAt(p.rotY / DEG)).toBeCloseTo(1, 9);
        // the size changes smoothly (no pop): at most 8% a 2% step; it may
        // ease down a little where the desktop back is fitted to its lane
        expect(p.scale).toBeGreaterThanOrEqual(prev.scale * 0.995);
        expect(p.scale / prev.scale).toBeLessThan(1.08);
        prev = p;
      }
    }
  });

  it('Buyback to Recent Pulls: it stands up first, then turns back', () => {
    const l = LAYOUT.phone;
    const ctx = ctxFor('gold-pack', false);
    const rest = restBlock(restState(2), 2, l, false, false);
    const early = focusPose(rest, 4.3, 0, 2, 2, l, false, false, ctx);
    expect(Math.abs(early.rotY / DEG)).toBeCloseTo(176, 6);
    expect(early.rotZ / DEG).toBeLessThan(90);
  });

  it('phone: the nearer crimped end stays on screen at both back stops', () => {
    const W = 390;
    const H = 716;
    for (const slug of SLUGS) {
      const keys = focusKeys(slug, false, 'sleeve');
      const odds = keys.find((k) => k.kind === 'odds')!;
      const bb = keys.find((k) => k.kind === 'buyback')!;
      expect(odds.cx * W - (odds.long * H) / 2).toBeGreaterThan(7);
      expect(W - (bb.cx * W + (bb.long * H) / 2)).toBeGreaterThan(7);
    }
  });
});

describe('timing helpers', () => {
  it('power1InOut and the 20% text switch', () => {
    expect(power1InOut(0)).toBe(0);
    expect(power1InOut(0.5)).toBe(0.5);
    expect(power1InOut(1)).toBe(1);
    expect(blockAt(1.19, 6)).toBe(1);
    expect(blockAt(1.2, 6)).toBe(2);
    expect(blockAt(1.21, 6)).toBe(2);
    // going back up the switch is at the same place
    expect(blockAt(1.19, 6)).toBe(1);
  });
});

describe('desktop back stops: the pack lies between the text and the icons', () => {
  const panels = [
    { w: 1440, h: 831 },
    { w: 1024, h: 700 },
    { w: 1280, h: 531 },
    { w: 1920, h: 1011 },
    { w: 2560, h: 1371 },
    { w: 3440, h: 1371 },
  ];
  it('every pack, at Pull Odds and Buyback, at every desktop panel', () => {
    for (const slug of SLUGS)
      for (const panel of panels) {
        const l: StageLayout = { ...LAYOUT.desktop, cx: panel.w / 2 };
        const ctx: FocusCtx = { ...ctxFor(slug, true), panel };
        const left = DESKTOP_BACK_LANE.left * panel.w + DESKTOP_BACK_LANE.gap;
        const right = DESKTOP_BACK_LANE.right * panel.w - DESKTOP_BACK_LANE.gap;
        ctx.keys.forEach((key, k) => {
          if (key.face !== 'back') return;
          const p = focusPose(
            restBlock(restState(2), 2, l, true, false),
            k + 1,
            0,
            2,
            2,
            l,
            true,
            false,
            ctx,
          );
          // lying down (rz 90), the long side runs across the panel
          const half = (p.scale * l.artH) / 2;
          const cx = (l.cx / panel.w + p.fx) * panel.w;
          expect(cx - half).toBeGreaterThanOrEqual(left - 1e-6);
          expect(cx + half).toBeLessThanOrEqual(right + 1e-6);
        });
      }
  });

  it('keeps a pose that already fits, and shrinks one that is too long', () => {
    const w = 1440;
    const h = 831;
    const fits = { cx: 0.7, long: 0.5 };
    expect(fitBackKey(fits, w, h)).toEqual(fits);
    const big = fitBackKey({ cx: 0.5, long: 2 }, w, h);
    const lane =
      (DESKTOP_BACK_LANE.right - DESKTOP_BACK_LANE.left) * w -
      2 * DESKTOP_BACK_LANE.gap;
    expect(big.long * h).toBeCloseTo(lane, 6);
  });

  it('leaves the phone poses as the table has them', () => {
    const ctx = ctxFor('151', false);
    const table = (POSES.packs as Record<string, Record<string, unknown>>)[
      '151'
    ]!.phone as Record<string, { cx: number }>;
    ctx.keys.forEach((key) => expect(key.cx).toBe(table[key.kind]!.cx));
  });
});

describe('phone Front and Closing: the pack ends above the text under it', () => {
  const panels = [
    { w: 320, h: 435 },
    { w: 360, h: 667 },
    { w: 390, h: 710 },
    { w: 430, h: 799 },
  ];
  it('every pack, at every phone panel', () => {
    for (const slug of SLUGS)
      for (const panel of panels) {
        const l: StageLayout = { ...LAYOUT.phone, cx: panel.w / 2 };
        const ctx: FocusCtx = { ...ctxFor(slug, false), panel };
        ctx.keys.forEach((key, k) => {
          if (key.kind !== 'front' && key.kind !== 'closing') return;
          const p = focusPose(
            restBlock(restState(2), 2, l, false, false),
            k + 1,
            0,
            2,
            2,
            l,
            false,
            false,
            ctx,
          );
          const len = p.scale * l.artH; // upright: the long side runs down
          const cy = (l.cy / panel.h + p.fy) * panel.h;
          expect(cy + len / 2).toBeLessThanOrEqual(
            panel.h - phoneTextReserve(panel.w) + 1e-6,
          );
          // the top stays where the table puts it
          expect(cy - len / 2).toBeCloseTo(
            (key.cy - key.long / 2) * panel.h,
            6,
          );
        });
      }
  });

  it('keeps the reference phone (390 x 710) exactly as the table has it', () => {
    const key = { cx: 0.45, cy: 0.35, long: 0.58 };
    expect(fitPhoneTextKey(key, 390, 710)).toEqual({ cy: 0.35, long: 0.58 });
  });
});
