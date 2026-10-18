/** Every credit_transaction.reason (models/credit-transaction.ts). A drift
 *  guard in __tests__/reasons.unit.spec.ts keeps the two lists equal. */
export const CREDIT_REASONS = [
  'buyback',
  'topup',
  'pack_open',
  'adjustment',
  'cashout',
  'voucher_claim',
  'reward_credit',
  'daily_reward',
  'referral_commission',
  'delivery_fee',
  'bonus_grant',
] as const;

export type CreditReason = (typeof CREDIT_REASONS)[number];

/** `?reasons=topup,cashout` → the reasons to keep. Absent or blank → null
 *  (every row). An unknown reason or a repeated parameter → 'invalid' (400):
 *  a dropped filter would answer a question nobody asked. */
export function parseReasons(raw: unknown): CreditReason[] | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return 'invalid';
  const list = [...new Set(raw.split(',').map((r) => r.trim()))];
  if (list.some((r) => !(CREDIT_REASONS as readonly string[]).includes(r))) {
    return 'invalid';
  }
  return list as CreditReason[];
}
