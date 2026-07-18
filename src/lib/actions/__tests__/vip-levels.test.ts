import { describe, it, expect } from 'vitest';
// mapVipLevels lives in vip-map.ts, not vip.ts: vip.ts has a module-level
// 'use server' directive, and Next.js requires every value export from such
// a file to be an async function (see the header comment in vip-map.ts and
// the identical pack-batch-map.ts / vault-map.ts precedent in this repo).
// vip.ts re-exports the `VipLevel` type only.
import { mapVipLevels } from '@/lib/actions/vip-map';

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
          direct_referral_pct: 2,
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
          directReferralPct: 2,
        },
      },
    ]);
  });

  it('returns [] for an empty ladder', () => {
    expect(mapVipLevels([])).toEqual([]);
  });
});
