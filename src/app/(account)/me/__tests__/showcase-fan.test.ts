import { describe, expect, it } from 'vitest';
import { FAN_MAX, fanPose, joinedLabel } from '../showcase-fan';

describe('the showcase fan', () => {
  it('raises the centre card highest and largest, and mirrors the sides', () => {
    const poses = Array.from({ length: 5 }, (_, i) => fanPose(i, 5));
    expect(poses.map((p) => p.rotate)).toEqual([-16, -8, 0, 8, 16]);
    expect(poses.map((p) => p.y)).toEqual([12, -10, -22, -10, 12]);
    expect(poses[2]?.scale).toBe(1.14);
    expect(poses[2]?.z).toBeGreaterThan(poses[1]?.z ?? 99);
    expect(poses[0]?.y).toBe(poses[4]?.y);
  });

  it('stands a single card straight and centred', () => {
    expect(fanPose(0, 1)).toMatchObject({ rotate: 0, y: -22, scale: 1.14 });
  });

  it('splits an even count around the middle', () => {
    const [a, b] = [fanPose(0, 2), fanPose(1, 2)];
    expect(a.rotate).toBe(-4);
    expect(b.rotate).toBe(4);
    expect(a.y).toBe(b.y);
    expect(a.y).toBeGreaterThan(-22);
    expect(a.y).toBeLessThan(-10);
  });

  it('never fans more than FAN_MAX cards', () => {
    expect(FAN_MAX).toBe(5);
  });
});

describe('the joined date', () => {
  it('reads as month and two-digit year, the same everywhere', () => {
    expect(joinedLabel('2026-10-04T23:30:00.000Z')).toBe('OCT 26');
    expect(joinedLabel('2025-01-01T00:00:00.000Z')).toBe('JAN 25');
  });

  it('is empty for a date it cannot read', () => {
    expect(joinedLabel('not a date')).toBe('');
  });
});
