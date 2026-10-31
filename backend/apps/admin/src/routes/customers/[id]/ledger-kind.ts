/** What a wallet row was, in staff words (playerMoney.kind.* labels). */
export type LedgerKind =
  | 'topup'
  | 'topupReversed'
  | 'withdrawal'
  | 'withdrawalRefund'
  | 'packOpen'
  | 'packRefund'
  | 'sellback'
  | 'bonusGiven'
  | 'bonusTaken'
  | 'adjustmentIn'
  | 'adjustmentOut'
  | 'deliveryFee'
  | 'deliveryRefund'
  | 'reward'
  | 'voucher'
  | 'dailyReward'
  | 'referral'
  | 'other';

/** A credit_transaction row's kind: its reason, the sign telling a charge
 *  from its refund (a +cashout is a refunded withdrawal, a +pack_open a
 *  reversed open, a +delivery_fee a cancelled shipment's refund). */
export function ledgerKind(reason: string, amount: number): LedgerKind {
  const plus = amount > 0;
  switch (reason) {
    case 'topup':
      return plus ? 'topup' : 'topupReversed';
    case 'cashout':
      return plus ? 'withdrawalRefund' : 'withdrawal';
    case 'pack_open':
      return plus ? 'packRefund' : 'packOpen';
    case 'buyback':
      return 'sellback';
    case 'bonus_grant':
      return plus ? 'bonusGiven' : 'bonusTaken';
    case 'adjustment':
      return plus ? 'adjustmentIn' : 'adjustmentOut';
    case 'delivery_fee':
      return plus ? 'deliveryRefund' : 'deliveryFee';
    case 'reward_credit':
      return 'reward';
    case 'voucher_claim':
      return 'voucher';
    case 'daily_reward':
      return 'dailyReward';
    case 'referral_commission':
      return 'referral';
    default:
      return 'other';
  }
}

/** What a wallet row was about, on one line: 'Gold Pack · Charizard #5 +2' for
 *  a pack open, the card for a sell-back, null when the row names neither. */
export function ledgerSubject(tx: {
  reason: string;
  pack_title?: string | null;
  cards?: { name: string }[];
}): string | null {
  const [first, ...rest] = tx.cards ?? [];
  if (!first) return null;
  const card = first.name + (rest.length ? ` +${rest.length}` : '');
  return tx.reason === 'pack_open' && tx.pack_title
    ? `${tx.pack_title} · ${card}`
    : card;
}

/** The Wallet tab's filters → the reasons each keeps (GET
 *  /admin/customers/:id/transactions?reasons=). Every reason is in exactly
 *  one, so "All" is the sum of the rest. */
export const WALLET_FILTERS = {
  all: null,
  money: ['topup', 'cashout'],
  packs: ['pack_open'],
  sellbacks: ['buyback'],
  rewards: [
    'bonus_grant',
    'reward_credit',
    'voucher_claim',
    'daily_reward',
    'referral_commission',
  ],
  other: ['adjustment', 'delivery_fee'],
} as const satisfies Record<string, readonly string[] | null>;

export type WalletFilter = keyof typeof WALLET_FILTERS;
