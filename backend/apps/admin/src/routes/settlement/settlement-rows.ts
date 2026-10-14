import type { SettlementPeriod } from '../../lib/admin-rest';

export type ResultRow = {
  period: string;
  inGross: number;
  inCount: number;
  /** Deposit fee + payout fee. */
  fees: number;
  /** The two fees apart: the gateway charges each direction its own rate. */
  inFee: number;
  outFee: number;
  outGross: number;
  outCount: number;
  /** Money in − both fees − money out. */
  net: number;
  /** The deposit ledger gap, 0 when within half a sen. */
  gap: number;
  /** The payout ledger gap (timing-skewed by design), 0 within half a sen. */
  payoutGap: number;
  feeFloor: boolean;
  grossFloor: boolean;
};

// `+ 0` turns a rounded -0 into 0, so a period that nets to nothing never
// prints "RM -0.00".
const cents = (n: number) => Math.round(n * 100) / 100 + 0;

/**
 * One row of the Settlement results table. The ledger check is the DEPOSIT
 * delta: the withdrawal delta is timing-skewed by design (a payout is debited
 * when it is requested and settles later), so it is shown as a quiet second
 * line, never as the check itself.
 */
export const resultRow = (p: SettlementPeriod): ResultRow => ({
  period: p.period,
  inGross: p.deposits.gross,
  inCount: p.deposits.count,
  fees: cents(p.deposits.fee + p.withdrawals.fee),
  inFee: p.deposits.fee,
  outFee: p.withdrawals.fee,
  outGross: p.withdrawals.gross,
  outCount: p.withdrawals.count,
  net: cents(
    p.deposits.gross - p.deposits.fee - p.withdrawals.fee - p.withdrawals.gross,
  ),
  gap: Math.abs(p.delta.deposits) < 0.005 ? 0 : p.delta.deposits,
  payoutGap: Math.abs(p.delta.withdrawals) < 0.005 ? 0 : p.delta.withdrawals,
  feeFloor: p.deposits.missingNet + p.withdrawals.missingNet > 0,
  grossFloor: p.deposits.missingGross > 0,
});
