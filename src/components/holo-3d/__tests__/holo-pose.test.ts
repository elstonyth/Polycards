import { describe, expect, test } from 'vitest';
import { actionPose, type HoloKind } from '../holo-pose';

const KINDS: HoloKind[] = ['crown', 'gift', 'vault'];
const SIXTH = Math.PI / 3;

describe('actionPose', () => {
  test('rests at both ends, so a play joins the idle motion without a jump', () => {
    for (const kind of KINDS)
      for (const p of [-1, 0, 1, 2])
        expect(Object.values(actionPose(kind, p))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('the crown turns exactly once', () => {
    expect(actionPose('crown', 0.5).turn).toBeCloseTo(Math.PI);
    expect(actionPose('crown', 0.999).turn).toBeCloseTo(Math.PI * 2, 1);
  });

  test('the gift lid pops fully open, then shuts', () => {
    expect(actionPose('gift', 0.5).lid).toBeCloseTo(1);
    expect(actionPose('gift', 0.999).lid).toBeCloseTo(0, 2);
  });

  test('the vault door waits for the wheel, and the wheel stops on a spoke', () => {
    expect(actionPose('vault', 0.2).door).toBe(0);
    expect(actionPose('vault', 0.2).wheel).toBeGreaterThan(0);
    expect(actionPose('vault', 0.65).door).toBeCloseTo(1);
    const turned = actionPose('vault', 0.9).wheel / SIXTH;
    expect(turned).toBeCloseTo(Math.round(turned));
    expect(actionPose('vault', 0.999).door).toBeCloseTo(0, 2);
  });
});
