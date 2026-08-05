import {
  VIP_LEVELS,
  VIP_LEVELS_SEED,
} from '../../../scripts/vip-levels.data';

describe('VIP_LEVELS data', () => {
  it('has exactly 100 rows, levels 1..100 unique', () => {
    expect(VIP_LEVELS).toHaveLength(100);
    const levels = VIP_LEVELS.map((r) => r.level);
    expect(new Set(levels).size).toBe(100);
    expect(Math.min(...levels)).toBe(1);
    expect(Math.max(...levels)).toBe(100);
  });

  it('has strictly increasing whole-MYR thresholds 0..3,000,000', () => {
    const byLevel = [...VIP_LEVELS].sort((a, b) => a.level - b.level);
    expect(byLevel[0].spend_threshold).toBe(0);
    expect(byLevel[99].spend_threshold).toBe(3_000_000);
    for (let i = 1; i < byLevel.length; i++) {
      expect(byLevel[i].spend_threshold).toBeGreaterThan(
        byLevel[i - 1].spend_threshold,
      );
      expect(Number.isInteger(byLevel[i].spend_threshold)).toBe(true);
    }
  });

  it('has the agreed referral-% bands (L40=4, L50-100=5)', () => {
    const at = (lvl: number) =>
      VIP_LEVELS.find((r) => r.level === lvl)!.direct_referral_pct;
    expect(at(1)).toBe(1);
    expect(at(40)).toBe(4);
    expect(at(50)).toBe(5);
    expect(at(100)).toBe(5);
  });

  it('unlocks a frame at every 10th level and Z box at 100', () => {
    for (const r of VIP_LEVELS) {
      expect(r.frame_unlock).toBe(r.level % 10 === 0);
    }
    expect(VIP_LEVELS.find((r) => r.level === 100)!.box_tier).toBe('Z');
  });
});

describe('VIP_LEVELS_SEED', () => {
  // What the seeders actually INSERT. Vouchers are off across the ladder
  // (Migration20260805000000 zeroed the live rows), so a fresh environment
  // must not seed them back. Seed scripts do not run in CI — without this,
  // re-pointing a seeder at VIP_LEVELS keeps the suite green and quietly
  // re-voucherizes the next fresh database.
  it('carries the workbook ladder with every voucher zeroed', () => {
    expect(VIP_LEVELS_SEED).toHaveLength(VIP_LEVELS.length);
    expect(VIP_LEVELS_SEED.every((r) => r.voucher_amount === 0)).toBe(true);
    // Same rungs in the same order — only the payout differs.
    expect(VIP_LEVELS_SEED.map((r) => r.level)).toEqual(
      VIP_LEVELS.map((r) => r.level),
    );
    expect(VIP_LEVELS_SEED.map((r) => r.spend_threshold)).toEqual(
      VIP_LEVELS.map((r) => r.spend_threshold),
    );
    expect(VIP_LEVELS_SEED.map((r) => r.box_tier)).toEqual(
      VIP_LEVELS.map((r) => r.box_tier),
    );
    expect(VIP_LEVELS_SEED.map((r) => r.frame_unlock)).toEqual(
      VIP_LEVELS.map((r) => r.frame_unlock),
    );
    expect(VIP_LEVELS_SEED.map((r) => r.direct_referral_pct)).toEqual(
      VIP_LEVELS.map((r) => r.direct_referral_pct),
    );
  });

  // The sheet keeps its figures — this is the record of the workbook, and a
  // future re-price reads it rather than digging through a seed script.
  it('leaves VIP_LEVELS itself untouched', () => {
    expect(VIP_LEVELS.some((r) => r.voucher_amount > 0)).toBe(true);
  });
});
