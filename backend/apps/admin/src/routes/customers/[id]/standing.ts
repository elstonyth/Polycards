import type { CustomerMoney } from '../../../lib/admin-rest';

export type StandingKey =
  | 'topups'
  | 'fees'
  | 'withdrawals'
  | 'fx'
  | 'kept'
  | 'wallet'
  | 'inflight'
  | 'commission'
  | 'cards'
  | 'shipped'
  | 'result';

export type StandingRow = {
  key: StandingKey;
  /** Signed RM: money in positive, money out negative. */
  amount: number;
  /** Bar position and length, percent of the track (0..100). */
  left: number;
  width: number;
  tone: 'in' | 'out' | 'kept' | 'loss';
  /** A subtotal (cash kept, the result), drawn from the left edge. */
  total: boolean;
};

type Input = {
  cash: Pick<CustomerMoney['cash'], 'fx_earned' | 'kept'> & {
    topups: { gross: number; fees: number };
    withdrawals: { gross: number; fees: number };
  };
  owed: Pick<
    CustomerMoney['owed'],
    'wallet_cash' | 'payouts_in_flight' | 'commission_unpaid'
  > & {
    cards: { sellback: number };
    shipped: { value: number };
    if_all_cashed_out: number;
  };
};

// Percent of `max`, clamped to the track and rounded so float noise never
// shows up as 40.400000000000006 (the money trail's rule).
const pct = (n: number, max: number) =>
  max > 0
    ? Math.round(Math.min(100, Math.max(0, (n / max) * 100)) * 1e4) / 1e4
    : 0;

/**
 * Where the house stands with one player: the Profit report's money trail
 * (top-ups, fees, withdrawals paid, the FX spread, cash kept), carried on
 * through what they could still take out (wallet, payouts not paid yet,
 * unpaid commission, vault cards at sell-back) and the cards already shipped,
 * down to "if they cashed out now". Each step comes off (or adds to) what was
 * left before it; the track scales to the larger of money in and money out,
 * so a loss still fits. Optional steps show only when non-zero.
 */
export function standing({ cash, owed }: Input): { rows: StandingRow[] } {
  type Step = [StandingKey, number];
  // 0 − x, not −x: nothing owed must read 0, never −0.
  const out = (n: number) => 0 - n;
  const before: Step[] = [
    ['topups', cash.topups.gross],
    ['fees', out(cash.topups.fees + cash.withdrawals.fees)],
    ['withdrawals', out(cash.withdrawals.gross)],
  ];
  if (cash.fx_earned !== 0) before.push(['fx', cash.fx_earned]);
  const after: Step[] = [['wallet', out(owed.wallet_cash)]];
  if (owed.payouts_in_flight !== 0)
    after.push(['inflight', out(owed.payouts_in_flight)]);
  if (owed.commission_unpaid !== 0)
    after.push(['commission', out(owed.commission_unpaid)]);
  after.push(['cards', out(owed.cards.sellback)]);
  after.push(['shipped', out(owed.shipped.value)]);

  const steps = [...before, ...after];
  const max = Math.max(
    steps.reduce((s, [, n]) => s + Math.max(0, n), 0),
    steps.reduce((s, [, n]) => s + Math.max(0, -n), 0),
  );
  let running = 0;
  const step = ([key, amount]: Step): StandingRow => {
    const from = running;
    running += amount;
    return {
      key,
      amount,
      left: pct(Math.max(0, Math.min(from, running)), max),
      width: pct(Math.abs(amount), max),
      tone: amount < 0 ? 'out' : 'in',
      total: false,
    };
  };
  const total = (key: StandingKey, amount: number): StandingRow => ({
    key,
    amount,
    left: 0,
    width: pct(Math.abs(amount), max),
    tone: amount < 0 ? 'loss' : 'kept',
    total: true,
  });
  const rows = before.map(step);
  rows.push(total('kept', cash.kept));
  rows.push(...after.map(step));
  rows.push(total('result', owed.if_all_cashed_out));
  return { rows };
}
