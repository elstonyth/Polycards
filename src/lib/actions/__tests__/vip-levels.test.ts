import { describe, it, expect } from 'vitest';
// mapVipLevels lives in vip-map.ts, not vip.ts: vip.ts has a module-level
// 'use server' directive, and Next.js requires every value export from such
// a file to be an async function (see the header comment in vip-map.ts and
// the identical pack-batch-map.ts / vault-map.ts precedent in this repo).
// vip.ts re-exports the `VipLevel` type only.
import { mapVipLevels } from '@/lib/actions/vip-map';
import { parseOne, VipSchema } from '@/lib/data/schemas';

describe('mapVipLevels', () => {
  it('maps snake_case wire rows to camelCase VipLevel', () => {
    const out = mapVipLevels([
      {
        level: 2,
        threshold: 3.09,
        reward: {
          voucher_amount: 2,
          box_tier: 'a',
          frame_unlock: false,
        },
      },
    ]);
    expect(out).toEqual([
      {
        level: 2,
        threshold: 3.09,
        reward: {
          voucherAmount: 2,
          boxTier: 'a',
          frameUnlock: false,
        },
      },
    ]);
  });

  it('returns [] for an empty ladder', () => {
    expect(mapVipLevels([])).toEqual([]);
  });
});

describe('VipSchema.levels — one bad rung must not blank the card (#516)', () => {
  const reward = { voucher_amount: 2, box_tier: 'a', frame_unlock: false };
  const base = {
    level: 2,
    highest_level_ever: 2,
    spend: 500,
    next: { level: 3, threshold: 1000, remaining: 500, reward },
  };

  it('drops the malformed rung and keeps the rest', () => {
    const v = parseOne(VipSchema, {
      ...base,
      levels: [
        { level: 1, threshold: 0, reward },
        // frame_unlock missing — the exact shape that used to fail the WHOLE
        // parse, so getVip returned ok:false and /me rendered no LV card at all.
        {
          level: 2,
          threshold: 500,
          reward: { voucher_amount: 5, box_tier: 'b' },
        },
        { level: 3, threshold: 1000, reward },
      ],
    });
    expect(v).not.toBeNull();
    expect(v!.levels.map((l) => l.level)).toEqual([1, 3]);
    // And the teaser the customer actually reads is untouched by the hole.
    expect(v!.next?.remaining).toBe(500);
  });

  it('a rung that is not an object at all drops the same way', () => {
    const v = parseOne(VipSchema, { ...base, levels: [null, 'nope', 7] });
    expect(v).not.toBeNull();
    expect(v!.levels).toEqual([]);
  });

  it('an omitted ladder still parses to []', () => {
    // `.default([])` survives the droppableArray swap.
    expect(parseOne(VipSchema, base)?.levels).toEqual([]);
  });

  it('a good ladder round-trips into mapVipLevels unchanged', () => {
    // Pins the inferred VipLevelRow: if droppableArray had widened or
    // optionalised the element type, this call would stop type-checking.
    const v = parseOne(VipSchema, {
      ...base,
      levels: [{ level: 1, threshold: 0, reward }],
    });
    expect(mapVipLevels(v!.levels)).toEqual([
      {
        level: 1,
        threshold: 0,
        reward: { voucherAmount: 2, boxTier: 'a', frameUnlock: false },
      },
    ]);
  });
});
