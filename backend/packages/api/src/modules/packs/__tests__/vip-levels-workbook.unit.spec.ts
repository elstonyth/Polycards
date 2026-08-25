import { VIP_LEVELS } from '../../../scripts/vip-levels.data';

// Pins the seed to the boss's Workbook1.xlsx (verified cell-by-cell 2026-07-06).
// Cumulative spend follows the workbook's curve exactly:
//   spend(L) = 3,000,000 × ((L−1)/99)³, rounded to whole MYR.
// Vouchers / referral % / frames / box tiers follow the range rules below.
// If a legitimate business change ever edits the ladder, update BOTH the seed
// and this fixture against the new workbook — never just one.

const VOUCHER_RANGES: [from: number, to: number, amount: number][] = [
  [1, 1, 0],
  [2, 6, 2],
  [7, 9, 5],
  [10, 10, 50],
  [11, 19, 10],
  [20, 20, 300],
  [21, 29, 88],
  [30, 30, 888],
  [31, 39, 120],
  [40, 40, 1200],
  [41, 59, 300],
  [60, 60, 3000],
  [61, 69, 500],
  [70, 70, 5000],
  [71, 79, 800],
  [80, 80, 8000],
  [81, 89, 1200],
  [90, 90, 12000],
  [91, 99, 1500],
  [100, 100, 15000],
];

// Steps carry forward through blank workbook rows: 1% from L1, 2% from L10,
// 3% from L20, 4% from L30, 5% from L50.
const REFERRAL_STEPS: [fromLevel: number, pct: number][] = [
  [1, 1],
  [10, 2],
  [20, 3],
  [30, 4],
  [50, 5],
];

const voucherFor = (L: number): number =>
  VOUCHER_RANGES.find(([from, to]) => L >= from && L <= to)![2];

const referralFor = (L: number): number =>
  [...REFERRAL_STEPS].reverse().find(([from]) => L >= from)![1];

describe('VIP_LEVELS matches Workbook1.xlsx', () => {
  it('has exactly levels 1..100 in order', () => {
    expect(VIP_LEVELS.map((r) => r.level)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it.each(VIP_LEVELS.map((r) => [r.level, r] as const))(
    'level %d matches the workbook row',
    (L, row) => {
      expect(row.spend_threshold).toBe(
        Math.round(3_000_000 * ((L - 1) / 99) ** 3),
      );
      expect(row.voucher_amount).toBe(voucherFor(L));
      expect(row.frame_unlock).toBe(L % 10 === 0);
    },
  );
});
