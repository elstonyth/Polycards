// GET /admin/stats — the result shape. The window math is myt-window.ts
// (re-exported here for its callers).
export {
  STATS_RANGES,
  statsWindows,
  type StatsWindow,
  type StatsWindows,
} from './myt-window';

// Top-up figures are the payment gateway's settled deposits (gateway_deposit),
// never wallet credits: manual adjustments do not count.
export type SignupTopupStats = {
  /** Accounts created (customer.has_account), deleted ones included,
   *  operator-generated partner accounts excluded. */
  signups: number;
  /** Settled gateway deposits. */
  topup_count: number;
  /** Distinct customers with at least one settled deposit in the window. */
  topup_customers: number;
  /** MYR, Σ amount_settled. */
  topup_amount: number;
  /** Customers whose first-ever settled deposit falls in the window. */
  first_topup_count: number;
  /** MYR, the sum of those first deposits. */
  first_topup_amount: number;
};

export type WithdrawalStats = {
  /** Settled gateway payouts. */
  withdrawal_count: number;
  /** MYR, Σ amount (the debit), like the Settlement report. */
  withdrawal_amount: number;
};

/** One of GET /admin/stats/leaders' top players for a window. */
export type PeriodLeader = {
  customer_id: string;
  /** First and last name, null when neither is set. */
  name: string | null;
  /** Null when the customer row is gone. */
  email: string | null;
  /** MYR; null for draws, which are counted, not summed. */
  amount: number | null;
  /** Top-ups, payouts or pack opens behind it (1 for the biggest top-up). */
  count: number;
};

export type PeriodLeaders = {
  /** Most settled top-ups, summed. */
  topped_up: PeriodLeader | null;
  /** The largest single settled top-up. */
  biggest_topup: PeriodLeader | null;
  /** Most settled payouts, summed. */
  withdrawn: PeriodLeader | null;
  /** Most paid pack opens. */
  draws: PeriodLeader | null;
};

