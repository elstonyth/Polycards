import { describe, it, expect } from 'vitest';
import {
  parseList,
  parseOne,
  PackRowSchema,
  OddsEntrySchema,
  RecentPullSchema,
  LeaderboardEntrySchema,
  PublicProfileSchema,
  VaultItemSchema,
  BalanceSchema,
  WonCardSchema,
  OpenBuybackSchema,
} from '../schemas';

describe('parseList — drops invalid items, never throws', () => {
  it('returns [] for non-arrays (mirrors Array.isArray guard)', () => {
    expect(parseList(PackRowSchema, null)).toEqual([]);
    expect(parseList(PackRowSchema, undefined)).toEqual([]);
    expect(parseList(PackRowSchema, {})).toEqual([]);
  });

  it('keeps valid pack rows, drops bad category/price (passes extra fields through)', () => {
    const rows = [
      { slug: 'a', category: 'pokemon', price: 10, title: 'A' },
      { slug: 'b', category: 42, price: 10 }, // non-string category → drop
      { slug: 'c', category: 'pokemon', price: NaN }, // non-finite price → drop
      { slug: 'd', category: 'pokemon', price: Infinity }, // → drop
      null, // → drop
    ];
    const out = parseList(PackRowSchema, rows);
    expect(out.map((r) => (r as unknown as { slug: string }).slug)).toEqual([
      'a',
    ]);
    expect((out[0] as unknown as { title: string }).title).toBe('A'); // looseObject passthrough
  });

  it('OddsEntry drops unknown rarity + non-finite value', () => {
    const out = parseList(OddsEntrySchema, [
      { handle: 'x', rarity: 'Epic', market_value: 5 },
      { handle: 'y', rarity: 'Nope', market_value: 5 }, // unknown rarity → drop
      { handle: 'z', rarity: 'Epic', market_value: NaN }, // → drop
    ]);
    expect(out).toHaveLength(1);
  });

  it('RecentPull requires handle + name + rarity + finite value', () => {
    const out = parseList(RecentPullSchema, [
      { handle: 'x', name: 'X', rarity: 'Rare', market_value: 1 },
      { handle: 'y', name: 42, rarity: 'Rare', market_value: 1 }, // bad name → drop
    ]);
    expect(out).toHaveLength(1);
  });

  it('Leaderboard requires name + finite points/volume/pulls', () => {
    const out = parseList(LeaderboardEntrySchema, [
      { name: 'A', points: 1, volume: 2, pulls: 3, seed: 9 },
      { name: 'B', points: 1, volume: 2, pulls: NaN }, // → drop
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as unknown as { seed: number }).seed).toBe(9); // passthrough
  });

  it('VaultItem requires pull_id + card.name + finite buyback.amount', () => {
    const good = { pull_id: 'p', card: { name: 'C' }, buyback: { amount: 5 } };
    const out = parseList(VaultItemSchema, [
      good,
      { pull_id: 'p', card: { name: 'C' } }, // missing buyback → drop
      { pull_id: 'p', card: {}, buyback: { amount: 5 } }, // missing card.name → drop
      { pull_id: 'p', card: { name: 'C' }, buyback: { amount: NaN } }, // → drop
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('parseOne — null on failure', () => {
  it('PublicProfile needs handle string + stats object', () => {
    expect(
      parseOne(PublicProfileSchema, { handle: 'h', stats: {} }),
    ).not.toBeNull();
    expect(parseOne(PublicProfileSchema, { handle: 'h' })).toBeNull();
    expect(parseOne(PublicProfileSchema, { stats: {} })).toBeNull();
    expect(parseOne(PublicProfileSchema, null)).toBeNull();
  });

  it('Balance / WonCard / OpenBuyback', () => {
    expect(parseOne(BalanceSchema, { balance: 10 })).not.toBeNull();
    expect(parseOne(BalanceSchema, { balance: NaN })).toBeNull();
    expect(
      parseOne(WonCardSchema, {
        handle: 'h',
        name: 'N',
        rarity: 'Epic',
        market_value: 1,
      }),
    ).not.toBeNull();
    expect(
      parseOne(WonCardSchema, {
        handle: 'h',
        name: 'N',
        rarity: 'Bad',
        market_value: 1,
      }),
    ).toBeNull();
    expect(
      parseOne(OpenBuybackSchema, { percent: 90, amount: 1 }),
    ).not.toBeNull();
    expect(parseOne(OpenBuybackSchema, { percent: 90 })).toBeNull();
  });
});
