import { describe, it, expect } from 'vitest';
import { milestoneBenefits } from '../vip-benefits';
import type { VipLevel } from '@/lib/actions/vip';

const lvl = (
  level: number,
  boxTier: string,
  frameUnlock: boolean,
): VipLevel => ({
  level,
  threshold: level,
  reward: { voucherAmount: 0, boxTier, frameUnlock },
});

describe('milestoneBenefits', () => {
  it('emits a row only where a frame/box perk changes', () => {
    const levels = [
      lvl(1, 'a', false),
      lvl(2, 'a', false),
      lvl(9, 'a', false),
      lvl(10, 'b', true), // frame + box upgrade
    ];
    expect(milestoneBenefits(levels)).toEqual([
      {
        level: 10,
        perks: ['New avatar frame', 'Daily box upgrades to Tier B'],
      },
    ]);
  });

  it('never emits a change row for the first level (no prior to compare)', () => {
    expect(milestoneBenefits([lvl(1, 'a', false)])).toEqual([]);
  });
});
