import { describe, expect, test } from 'vitest';
import {
  decadesWithErrors,
  groupByDecade,
  ladderShape,
} from './vip-ladder-shape';
import type { VipLevelRow } from './vip-levels-validate-client';

const row = (over: Partial<VipLevelRow> = {}): VipLevelRow => ({
  thresholdInput: '0',
  voucherInput: '300',
  boxTier: 'a',
  frameUnlock: false,
  referralInput: '1',
  ...over,
});

// 25 levels: tier a for 1-10, tier b for 11-25; frames on 10 and 20.
const ladder = Array.from({ length: 25 }, (_, i) =>
  row({
    thresholdInput: String(i * 100),
    boxTier: i < 10 ? 'a' : 'b',
    frameUnlock: i + 1 === 10 || i + 1 === 20,
  }),
);

describe('groupByDecade', () => {
  test('chunks into decades and keeps a partial tail', () => {
    const groups = groupByDecade(ladder);
    expect(groups.map((g) => [g.firstLevel, g.lastLevel])).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(groups[2].rows).toHaveLength(5);
    expect(groups[1].startIndex).toBe(10);
  });

  test('never drops or duplicates a row', () => {
    const flat = groupByDecade(ladder).flatMap((g) => g.rows);
    expect(flat).toEqual(ladder);
  });

  test('summarises tiers, frames and the threshold span per decade', () => {
    const [first, second] = groupByDecade(ladder);
    expect(first.tiers).toEqual(['a']);
    expect(first.frameLevels).toEqual([10]);
    expect(first.thresholdFrom).toBe('0');
    expect(first.thresholdTo).toBe('900');
    expect(second.frameLevels).toEqual([20]);
  });

  test('an empty ladder yields no groups', () => {
    expect(groupByDecade([])).toEqual([]);
  });
});

describe('ladderShape', () => {
  test('collapses consecutive equal tiers into runs', () => {
    expect(ladderShape(ladder).tierSegments).toEqual([
      { tier: 'a', from: 1, to: 10 },
      { tier: 'b', from: 11, to: 25 },
    ]);
  });

  test('reports only the decade slots this ladder reaches', () => {
    const s = ladderShape(ladder);
    expect(s.frameSlots).toEqual([10, 20]);
    expect(s.frameLevels).toEqual([10, 20]);
    expect(s.count).toBe(25);
    expect(s.topThreshold).toBe('2400');
  });
});

describe('decadesWithErrors', () => {
  test('maps a level in a message to its decade index', () => {
    expect([...decadesWithErrors(['Level 63: threshold must be a number.'])]).toEqual([6]);
    expect([...decadesWithErrors(['Level 10: bad', 'Level 11: bad'])]).toEqual([0, 1]);
  });

  test('ignores messages without a level', () => {
    expect(decadesWithErrors(['The ladder must have at least 1 level.']).size).toBe(0);
  });
});
