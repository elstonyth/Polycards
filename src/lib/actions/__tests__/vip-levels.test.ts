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
          boxTier: '',
          frameUnlock: false,
        },
      },
    ]);
  });

  it('returns [] for an empty ladder', () => {
    expect(mapVipLevels([])).toEqual([]);
  });
});

describe('VipSchema.next — a malformed teaser reward is harmless (#523)', () => {
  // The REAL wire shape: `box_tier` left the backend with #490
  // (Migration20260825120000 dropped the column).
  const reward = { voucher_amount: 2, frame_unlock: false };
  const base = {
    level: 2,
    highest_level_ever: 2,
    spend: 500,
    levels: [{ level: 1, threshold: 0, reward }],
  };

  it('parses when next.reward is malformed, instead of blanking the card', () => {
    const v = parseOne(VipSchema, {
      ...base,
      // frame_unlock missing and box_tier the wrong type. Before #523 `reward`
      // was a required, un-caught field on `next`, so this failed the WHOLE
      // parse -- parseOne null, getVip ok:false, and `{vipResult.ok && …}` on
      // /me removed the level, the bar and "RM x more to LV y" outright, over
      // data no surface has ever rendered.
      next: {
        level: 3,
        threshold: 1000,
        remaining: 500,
        reward: { voucher_amount: 5, box_tier: 42 },
      },
    });
    expect(v).not.toBeNull();
    // The three fields /me actually reads all survive intact.
    expect(v!.next).toMatchObject({
      level: 3,
      threshold: 1000,
      remaining: 500,
    });
  });

  it('parses when next.reward is missing entirely', () => {
    const v = parseOne(VipSchema, {
      ...base,
      next: { level: 3, threshold: 1000, remaining: 500 },
    });
    expect(v!.next?.remaining).toBe(500);
  });

  it('still fails on a teaser field /me DOES read', () => {
    // The looseObject is not a free pass: threshold feeds aria-valuemax and the
    // bar's denominator, so a missing one must still refuse rather than render
    // a nonsense bar.
    const v = parseOne(VipSchema, {
      ...base,
      next: { level: 3, remaining: 500, reward },
    });
    expect(v).toBeNull();
  });
});

describe('VipSchema.levels — one bad rung must not blank the card (#516)', () => {
  const reward = { voucher_amount: 2, frame_unlock: false };
  const base = {
    level: 2,
    highest_level_ever: 2,
    spend: 500,
    next: { level: 3, threshold: 1000, remaining: 500, reward },
  };

  it('keeps a rung shaped exactly as the backend sends it (no box_tier)', () => {
    // Every rung used to fail on the dropped `box_tier` column, so the whole
    // ladder parsed to [] and /me floored every progress bar at 0 (review C).
    const v = parseOne(VipSchema, {
      ...base,
      levels: [
        { level: 1, threshold: 0, reward },
        { level: 2, threshold: 500, reward },
      ],
    });
    expect(v!.levels.map((l) => l.threshold)).toEqual([0, 500]);
  });

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
          reward: { voucher_amount: 5 },
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
        reward: { voucherAmount: 2, boxTier: '', frameUnlock: false },
      },
    ]);
  });
});
