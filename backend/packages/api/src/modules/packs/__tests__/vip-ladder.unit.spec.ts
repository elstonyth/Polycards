import { levelForSpend, type VipLevelRow } from '../vip-ladder';

// Minimal fixture mirroring the real ladder's shape (thresholds strictly increasing).
const LADDER: VipLevelRow[] = [
  { level: 1, spend_threshold: 0 },
  { level: 2, spend_threshold: 3 },
  { level: 9, spend_threshold: 1583 },
  { level: 10, spend_threshold: 2254 },
  { level: 100, spend_threshold: 3000000 },
];

describe('levelForSpend', () => {
  it('returns level 1 at zero spend', () => {
    expect(levelForSpend(0, LADDER)).toBe(1);
  });

  it('returns the highest level whose threshold is met', () => {
    expect(levelForSpend(2253, LADDER)).toBe(9); // one sen short of L10
    expect(levelForSpend(2254, LADDER)).toBe(10); // exactly L10
  });

  it('caps at the top level beyond the last threshold', () => {
    expect(levelForSpend(3000000, LADDER)).toBe(100);
    expect(levelForSpend(99999999, LADDER)).toBe(100);
  });

  it('compares in integer sen (cents do not cross a threshold)', () => {
    expect(levelForSpend(2253.99, LADDER)).toBe(9);
    expect(levelForSpend(2254.0, LADDER)).toBe(10);
  });

  it('throws on an empty ladder', () => {
    expect(() => levelForSpend(100, [])).toThrow();
  });
});
