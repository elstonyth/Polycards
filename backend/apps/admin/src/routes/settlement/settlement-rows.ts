import type { SettlementPeriod } from '../../lib/admin-rest';

export type ResultRow = {
  period: string;
  inGross: number;
  inCount: number;
  /** Deposit fee + payout fee. */
  fees: number;
  outGross: number;
  outCount: number;
  /** Money in − both fees − money out. */
  net: number;
  /** The deposit ledger gap, 0 when within half a sen. */
  gap: number;
  feeFloor: boolean;
  grossFloor: boolean;
};

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * One row of the Settlement results table. The ledger check is the DEPOSIT
 * delta only: the withdrawal delta is timing-skewed by design (a payout is
 * debited when it is requested and settles later), so it lives in the ⓘ,
 * not in the check.
 */
export const resultRow = (p: SettlementPeriod): ResultRow => ({
  period: p.period,
  inGross: p.deposits.gross,
  inCount: p.deposits.count,
  fees: cents(p.deposits.fee + p.withdrawals.fee),
  outGross: p.withdrawals.gross,
  outCount: p.withdrawals.count,
  net: cents(
    p.deposits.gross - p.deposits.fee - p.withdrawals.fee - p.withdrawals.gross,
  ),
  gap: Math.abs(p.delta.deposits) < 0.005 ? 0 : p.delta.deposits,
  feeFloor: p.deposits.missingNet + p.withdrawals.missingNet > 0,
  grossFloor: p.deposits.missingGross > 0,
});
