import { describe, expect, test } from 'vitest';
import { ticketCard } from '@/lib/packs-data';
import {
  poolExpectedValue,
  poolValueRange,
  ticketOddsPool,
  ticketTopHits,
  tierValueRanges,
} from '@/lib/packs-format';

// A ticket pack's odds panel runs the same sums as a card pack's, with the ticket
// amount standing in for the price. The rates are always the published ones.

const POOL = [
  ticketCard(10, 'Common'),
  ticketCard(20, 'Common'),
  ticketCard(50, 'Rare'),
  ticketCard(1000, 'Immortal'),
];

describe('ticketOddsPool', () => {
  const rows = ticketOddsPool(POOL);

  test('a tier reads as the range of its ticket amounts', () => {
    expect(tierValueRanges(rows)).toEqual({
      Common: { min: 10, max: 20 },
      Rare: { min: 50, max: 50 },
      Immortal: { min: 1000, max: 1000 },
    });
  });

  test('the average weighs each tier by its published chance', () => {
    // Common averages 15, so 15 x 0.9 + 50 x 0.09 + 1000 x 0.01 = 28
    expect(poolExpectedValue(rows, { Common: 90, Rare: 9, Immortal: 1 })).toBe(
      28,
    );
  });

  test('published odds that do not add up give no average', () => {
    expect(poolExpectedValue(rows, { Common: 50 })).toBeNull();
  });

  test('a published tier with no amounts gives no average', () => {
    expect(poolExpectedValue(rows, { Common: 90, Mythical: 10 })).toBeNull();
  });

  test('the pack-wide range spans every amount', () => {
    expect(poolValueRange(rows)).toEqual({ min: 10, max: 1000 });
  });

  test('a ticket row on its own still has no price', () => {
    expect(poolValueRange(POOL)).toBeNull();
  });
});

describe('ticketTopHits', () => {
  test('keeps the top three tiers, biggest first', () => {
    const hits = ticketTopHits([
      ticketCard(10, 'Common'),
      ticketCard(100, 'Mythical'),
      ticketCard(1000, 'Immortal'),
      ticketCard(500, 'Legendary'),
    ]);
    expect(hits.map((c) => c.tickets)).toEqual([1000, 500, 100]);
  });

  test('a pack with no top tier still shows its biggest amounts', () => {
    const hits = ticketTopHits([
      ticketCard(10, 'Common'),
      ticketCard(50, 'Rare'),
    ]);
    expect(hits.map((c) => c.tickets)).toEqual([50, 10]);
  });

  test('does not reorder the pool it was given', () => {
    const pool = [ticketCard(10, 'Common'), ticketCard(50, 'Rare')];
    ticketTopHits(pool);
    expect(pool.map((c) => c.tickets)).toEqual([10, 50]);
  });
});
