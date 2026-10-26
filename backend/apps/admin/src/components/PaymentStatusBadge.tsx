import { StatusBadge } from '@medusajs/ui';
import type { GatewayDeposit, GatewayWithdrawal } from '../lib/admin-rest';

// Shared by the Deposits / Withdrawals pages and the player page's Payments
// tab, so one status reads in one colour everywhere.

// The orange alarm is for `stuck` rows only (server-side: pending two sweeps
// past the stale window, with a gateway id) — the one pending case that may be
// a customer who paid and was not credited. A merely `stale` row is almost
// always a customer who walked away, which the next sweep expires; it stays
// grey so it does not read as a gateway fault.
export const depositStatusBadge = (d: GatewayDeposit, label: string) => {
  if (d.status === 'settled')
    return <StatusBadge color="green">{label}</StatusBadge>;
  if (d.status === 'failed')
    return <StatusBadge color="red">{label}</StatusBadge>;
  // 'expired' needs its OWN colour, not the pending fall-through: the sweep
  // gave up on it while the gateway never ruled, which makes it the likeliest
  // uncredited payment on the page — exactly the row that must not read as
  // "still being chased". Purple because the other four are spoken for and
  // each carries a meaning this state would contradict: green settled, red
  // refused, orange the stuck-PENDING alarm, grey healthy-pending.
  if (d.status === 'expired')
    return <StatusBadge color="purple">{label}</StatusBadge>;
  return <StatusBadge color={d.stuck ? 'orange' : 'grey'}>{label}</StatusBadge>;
};

export const withdrawalStatusBadge = (w: GatewayWithdrawal, label: string) => {
  // held: needs a human, not the gateway — orange reads as "awaiting action"
  // the same way a stale pending row does, without conflating the two (a
  // held row's `stale` is always false; the sweep never touches it).
  if (w.status === 'held')
    return <StatusBadge color="orange">{label}</StatusBadge>;
  if (w.status === 'settled')
    return <StatusBadge color="green">{label}</StatusBadge>;
  // 'failed' on a withdrawal means the debit was REFUNDED — resolved, not an
  // error state, so it renders neutral rather than red.
  if (w.status === 'failed')
    return <StatusBadge color="blue">{label}</StatusBadge>;
  return <StatusBadge color={w.stale ? 'orange' : 'grey'}>{label}</StatusBadge>;
};
