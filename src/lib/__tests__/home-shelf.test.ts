import { describe, expect, test } from 'vitest';
import { groupPacksByTier } from '@/lib/home-shelf';
import type { Pack } from '@/lib/packs-data';

const pack = (id: string, price: string): Pack => ({
  id,
  name: id,
  price,
  image: `/images/${id}.png`,
});

describe('groupPacksByTier', () => {
  test('groups by price tier, racks ordered high tier first', () => {
    const racks = groupPacksByTier([
      pack('cheap', 'RM 10'), // common (<25)
      pack('mid', 'RM 150'), // rare (100–499)
      pack('big', 'RM 2,500'), // legendary (2000–9999)
    ]);
    expect(racks.map((r) => r.tier)).toEqual(['legendary', 'rare', 'common']);
    expect(racks[0]!.packs.map((p) => p.id)).toEqual(['big']);
  });

  test('keeps input order within a rack', () => {
    const racks = groupPacksByTier([pack('a', 'RM 120'), pack('b', 'RM 480')]);
    expect(racks).toHaveLength(1);
    expect(racks[0]!.packs.map((p) => p.id)).toEqual(['a', 'b']);
  });

  test('omits empty tiers and handles empty input', () => {
    expect(groupPacksByTier([])).toEqual([]);
  });

  test('unparseable price falls into common (priceTier fallback)', () => {
    const racks = groupPacksByTier([pack('weird', 'FREE')]);
    expect(racks).toHaveLength(1);
    expect(racks[0]!.tier).toBe('common');
    expect(racks[0]!.packs.map((p) => p.id)).toEqual(['weird']);
  });
});
