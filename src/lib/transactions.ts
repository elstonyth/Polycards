// Pure presentation helpers for the Transactions account page. Isomorphic (no
// server-only imports) so the server component can call them directly.
import type { CreditTxn } from '@/lib/actions/vault';
import { rm } from '@/lib/format';

const REASON_LABEL: Record<CreditTxn['reason'], string> = {
  topup: 'Top-up',
  pack_open: 'Pack open',
  buyback: 'Sell-back',
  adjustment: 'Adjustment',
  direct_referral: 'Referral commission',
  team_override: 'Team override',
  commission_reversal: 'Commission reversal',
  cashout: 'Cashout',
  voucher_claim: 'Voucher',
  reward_credit: 'Reward credit',
  daily_reward: 'Daily reward',
};

export const reasonLabel = (reason: CreditTxn['reason']): string =>
  REASON_LABEL[reason];

/** "+RM 48.00" for credits, "-RM 25.00" for spends (amount carries the sign). */
export function signedRm(amount: number): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
  return `${sign}${rm(Math.abs(amount))}`;
}
