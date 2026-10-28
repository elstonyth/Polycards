export type TrailRow = {
  key: 'topups' | 'fees' | 'withdrawals' | 'fx' | 'kept';
  /** Signed RM: money in positive, money out negative. */
  amount: number;
  /** Bar position and length, percent of the track (0..100). */
  left: number;
  width: number;
  tone: 'in' | 'out' | 'kept' | 'loss';
};

// Percent of `max`, clamped to the track and rounded so float noise never
// shows up as 40.400000000000006.
const pct = (n: number, max: number) =>
  max > 0
    ? Math.round(Math.min(100, Math.max(0, (n / max) * 100)) * 1e4) / 1e4
    : 0;

/**
 * The Profit report's money trail: top-ups fill the track from the left,
 * the gateway's fees both ways and then the withdrawals paid come off the
 * right of what remains, the regional rails' FX spread (when there is one)
 * adds back, and cash kept is what is left. Scaled to the larger of top-ups
 * and money out, so a loss still fits the track.
 */
export function moneyTrail(c: {
  topups: { gross: number; fees: number };
  withdrawals: { gross: number; fees: number };
  fx_earned: number;
  kept: number;
}): { max: number; rows: TrailRow[] } {
  const fees = c.topups.fees + c.withdrawals.fees;
  const paidOut = c.withdrawals.gross;
  const max = Math.max(c.topups.gross, fees + paidOut);
  const afterFees = c.topups.gross - fees;
  const afterOut = afterFees - paidOut;
  const rows: TrailRow[] = [
    {
      key: 'topups',
      amount: c.topups.gross,
      left: 0,
      width: pct(c.topups.gross, max),
      tone: 'in',
    },
    {
      key: 'fees',
      amount: 0 - fees,
      left: pct(Math.max(0, afterFees), max),
      width: pct(fees, max),
      tone: 'out',
    },
    {
      key: 'withdrawals',
      amount: 0 - paidOut,
      left: pct(Math.max(0, afterOut), max),
      width: pct(paidOut, max),
      tone: 'out',
    },
  ];
  if (c.fx_earned !== 0) {
    rows.push({
      key: 'fx',
      amount: c.fx_earned,
      left: pct(Math.max(0, afterOut), max),
      width: pct(Math.abs(c.fx_earned), max),
      tone: c.fx_earned < 0 ? 'out' : 'in',
    });
  }
  rows.push({
    key: 'kept',
    amount: c.kept,
    left: 0,
    width: pct(Math.abs(c.kept), max),
    tone: c.kept < 0 ? 'loss' : 'kept',
  });
  return { max, rows };
}
