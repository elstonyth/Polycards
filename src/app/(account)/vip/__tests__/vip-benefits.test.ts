import { describe, it, expect } from 'vitest';
import { milestoneBenefits } from '../vip-benefits';
import type { VipLevel } from '@/lib/actions/vip';

const lvl = (
  level: number,
  boxTier: string,
  frameUnlock: boolean,
  directReferralPct: number,
): VipLevel => ({
  level,
  threshold: level,
  reward: { voucherAmount: 0, boxTier, frameUnlock, directReferralPct },
});

describe('milestoneBenefits', () => {
  it('emits a row only where a frame/box/referral perk changes', () => {
    const levels = [
      lvl(1, 'a', false, 1),
      lvl(2, 'a', false, 2), // referral bump
      lvl(9, 'a', false, 2),
      lvl(10, 'b', true, 2), // frame + box upgrade
    ];
    expect(milestoneBenefits(levels)).toEqual([
      { level: 2, perks: ['Referral rate → 2%'] },
      {
        level: 10,
        perks: ['New avatar frame', 'Daily box upgrades to Tier B'],
      },
    ]);
  });

  it('never emits a change row for the first level (no prior to compare)', () => {
    expect(milestoneBenefits([lvl(1, 'a', false, 1)])).toEqual([]);
  });
});
