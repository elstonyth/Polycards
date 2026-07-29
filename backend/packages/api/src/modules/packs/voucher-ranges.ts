// Pure fold/collapse between the admin range editor ({from,to,amount}[]) and the
// stored per-level ladder (vip_level.voucher_amount for levels 1..100).
export type VoucherRange = { from: number; to: number; amount_myr: number };

const LEVELS = 100;

// Per-level payout ceiling. voucher_amount is a credit-minting lever once the
// rewards economy is live, so an admin write needs an upper bound like every
// sibling money input. 10_000 mirrors the credit-adjust ADJUST_MAX_RM ceiling
// and sits well above the seeded 0–888 range (see seed-reward-economy-demo.ts).
export const MAX_VOUCHER_MYR = 10_000;

export function foldRanges(ranges: VoucherRange[]): number[] {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error('At least one range is required.');
  }
  const out = new Array<number>(LEVELS).fill(-1);
  for (const r of ranges) {
    if (
      !Number.isInteger(r.from) || !Number.isInteger(r.to) ||
      r.from < 1 || r.to > LEVELS || r.from > r.to
    ) {
      throw new Error(`Invalid range ${r.from}–${r.to}: levels must be integers within 1–${LEVELS}.`);
    }
    // Same binary-representation epsilon as credit-adjust's adjustAmountError:
    // an exact integer-cents comparison would reject valid money like 0.07
    // (0.07 * 100 is 7.000000000000001). NOT 10.1 — that one is exactly 1010.
    const cents = r.amount_myr * 100;
    if (
      !(Number.isFinite(r.amount_myr) && r.amount_myr >= 0 && r.amount_myr <= MAX_VOUCHER_MYR) ||
      Math.abs(cents - Math.round(cents)) > 1e-6
    ) {
      throw new Error(`Invalid amount for range ${r.from}–${r.to}: must be between 0 and ${MAX_VOUCHER_MYR} with at most 2 decimals.`);
    }
    for (let level = r.from; level <= r.to; level++) {
      if (out[level - 1] !== -1) {
        throw new Error(`Ranges overlap at level ${level}.`);
      }
      out[level - 1] = r.amount_myr;
    }
  }
  const gapAt = out.indexOf(-1);
  if (gapAt !== -1) {
    throw new Error(`Gap: level ${gapAt + 1} is not covered by any range.`);
  }
  return out;
}

export function collapseLadder(amounts: number[]): VoucherRange[] {
  const ranges: VoucherRange[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const last = ranges[ranges.length - 1];
    if (last && last.amount_myr === amounts[i]) last.to = i + 1;
    else ranges.push({ from: i + 1, to: i + 1, amount_myr: amounts[i] });
  }
  return ranges;
}
