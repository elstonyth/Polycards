import { describe, expect, it } from 'vitest';
import {
  assignRoutes,
  flightPose,
  flightProgress,
  greatCircle,
  planeKind,
  ROUTES,
  shortTimeLeft,
  toVec,
} from '../draw-globe';

const len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);

describe('draw globe', () => {
  it('gives each tier its own plane', () => {
    expect(planeKind('economy')).toBe('prop');
    expect(planeKind('business')).toBe('jet');
    expect(planeKind('first')).toBe('jumbo');
    expect(planeKind(null)).toBe('prop');
  });

  it('keeps a gate on its route and never doubles up while one is free', () => {
    const ids = Array.from({ length: ROUTES.length }, (_, i) => `evt_${i}`);
    const all = assignRoutes(ids);
    expect(new Set(all.values()).size).toBe(ROUTES.length);
    // The same gate, among fewer: its route does not depend on the order asked.
    expect(assignRoutes([...ids].reverse())).toEqual(all);
    // More gates than routes still each get one.
    expect(assignRoutes([...ids, 'extra']).get('extra')).toBeTypeOf('number');
  });

  it('flies from open to close and lands when the gate closes', () => {
    const start = '2026-11-26T00:00:00Z';
    const end = '2026-11-28T00:00:00Z';
    const at = (iso: string) => flightProgress(start, end, Date.parse(iso));
    expect(at('2026-11-27T00:00:00Z')).toBeCloseTo(0.5);
    expect(at('2026-11-26T00:00:00Z')).toBe(0.03);
    expect(at('2026-11-27T23:59:59Z')).toBe(0.97);
    expect(at('2026-11-28T00:00:00Z')).toBe(1);
    expect(at('2026-12-01T00:00:00Z')).toBe(1);
    // A gate with a broken window still shows a plane.
    expect(flightProgress(end, start, Date.parse(start))).toBe(1);
    expect(flightProgress(start, start, Date.parse(start) - 1)).toBe(0.5);
  });

  it('puts places where the map has them', () => {
    expect(toVec([0, 0])).toEqual([1, 0, -0]);
    expect(toVec([0, 90])[1]).toBeCloseTo(1);
    // East is to the right of a viewer facing longitude 0: -Z.
    expect(toVec([90, 0])[2]).toBeCloseTo(-1);
  });

  it('follows the great circle between two places', () => {
    const a = toVec([0, 0]);
    const b = toVec([90, 0]);
    expect(greatCircle(a, b, 0)).toEqual(a);
    const mid = greatCircle(a, b, 0.5);
    expect(len(mid)).toBeCloseTo(1);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2);
    expect(greatCircle(a, a, 0.5)).toEqual(a);
  });

  it('cruises above the ground and lands level', () => {
    const [from, to] = ROUTES[0]!;
    const cruising = flightPose(from, to, 0.5, 0.17, 0.05);
    expect(len(cruising.position)).toBeCloseTo(1.22);
    expect(len(cruising.forward)).toBeCloseTo(1);
    const landed = flightPose(from, to, 1, 0.17, 0.05);
    expect(len(landed.position)).toBeCloseTo(1.05);
    const level =
      landed.forward[0] * landed.up[0] +
      landed.forward[1] * landed.up[1] +
      landed.forward[2] * landed.up[2];
    expect(level).toBeCloseTo(0);
  });

  it('flies level on the steep climb and descent', () => {
    const [from, to] = ROUTES[0]!;
    for (const s of [0.03, 0.97]) {
      const p = flightPose(from, to, s, 0.17, 0.05);
      const pitch =
        p.forward[0] * p.up[0] +
        p.forward[1] * p.up[1] +
        p.forward[2] * p.up[2];
      expect(pitch).toBeCloseTo(0);
    }
  });

  it('shortens the time left to two units', () => {
    expect(shortTimeLeft({ d: '03', h: '01', m: '13', s: '19' })).toBe(
      '3d 01h',
    );
    expect(shortTimeLeft({ d: '00', h: '05', m: '12', s: '09' })).toBe(
      '05h 12m',
    );
    expect(shortTimeLeft({ d: '00', h: '00', m: '12', s: '03' })).toBe(
      '12m 03s',
    );
  });
});
