// src/modules/packs/__tests__/vip-rewards.unit.spec.ts
import { levelsToGrant, rewardsForLevel } from '../vip-rewards';

describe('levelsToGrant', () => {
  it('first open to L5 grants L2..L5 (L1 entry tier skipped)', () => {
    expect(levelsToGrant(1, 5)).toEqual([2, 3, 4, 5]);
  });
  it('no rise grants nothing', () => {
    expect(levelsToGrant(5, 5)).toEqual([]);
  });
  it('brand-new (highest default 1) sub-threshold open grants nothing', () => {
    expect(levelsToGrant(1, 1)).toEqual([]);
  });
  it('never includes L1 even if highest is 0', () => {
    expect(levelsToGrant(0, 3)).toEqual([2, 3]);
  });
});

describe('rewardsForLevel', () => {
  it('voucher>0 emits voucher only; no box (tier derives live)', () => {
    const rewards = rewardsForLevel({
      level: 2,
      voucher_amount: 10,
      box_tier: 'a',
      frame_unlock: false,
    });
    expect(rewards).toEqual([{ kind: 'voucher', payload: { amount_myr: 10 } }]);
    expect(rewards.find((r) => r.kind === 'box')).toBeUndefined();
  });
  it('frame on a ×10 level; still no box', () => {
    const r = rewardsForLevel({
      level: 10,
      voucher_amount: 50,
      box_tier: 'a',
      frame_unlock: true,
    });
    expect(r).toContainEqual({ kind: 'frame', payload: { level: 10 } });
    expect(r.find((rr) => (rr.kind as string) === 'box')).toBeUndefined();
  });
  it('voucher_amount 0 omits the voucher; no box either', () => {
    const rewards = rewardsForLevel({
      level: 3,
      voucher_amount: 0,
      box_tier: 'a',
      frame_unlock: false,
    });
    expect(rewards).toEqual([]);
    expect(rewards.find((r) => r.kind === 'box')).toBeUndefined();
  });
});
