import { describe, expect, it } from 'vitest';
import { WALLET_FILTERS, ledgerKind, ledgerSubject } from './ledger-kind';

describe('ledgerSubject', () => {
  it('names the pack and card of an open, and how many more a batch held', () => {
    expect(
      ledgerSubject({
        reason: 'pack_open',
        pack_title: 'Gold Pack',
        cards: [{ name: 'Charizard #5' }, { name: 'A' }, { name: 'B' }],
      }),
    ).toBe('Gold Pack · Charizard #5 +2');
  });

  it('names only the card of a sell-back', () => {
    expect(
      ledgerSubject({
        reason: 'buyback',
        pack_title: 'Gold Pack',
        cards: [{ name: 'Charizard #5' }],
      }),
    ).toBe('Charizard #5');
  });

  it('names the pack alone for a ticket pack, which pulls no card', () => {
    expect(
      ledgerSubject({ reason: 'pack_open', pack_title: 'Lucky Pack', cards: [] }),
    ).toBe('Lucky Pack');
  });

  it('is null for a row about no card', () => {
    expect(ledgerSubject({ reason: 'topup', cards: [] })).toBeNull();
    expect(ledgerSubject({ reason: 'topup' })).toBeNull();
  });
});

// Every credit_transaction.reason (backend models/credit-transaction.ts).
const REASONS = [
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
];

describe('ledgerKind', () => {
  it('names a row by what happened, its sign deciding the direction', () => {
    expect(ledgerKind('topup', 100)).toBe('topup');
    expect(ledgerKind('topup', -100)).toBe('topupReversed');
    expect(ledgerKind('cashout', -50)).toBe('withdrawal');
    expect(ledgerKind('cashout', 50)).toBe('withdrawalRefund');
    expect(ledgerKind('pack_open', -10)).toBe('packOpen');
    expect(ledgerKind('pack_open', 10)).toBe('packRefund');
    expect(ledgerKind('buyback', 9)).toBe('sellback');
    expect(ledgerKind('bonus_grant', 50)).toBe('bonusGiven');
    expect(ledgerKind('bonus_grant', -50)).toBe('bonusTaken');
    expect(ledgerKind('adjustment', 5)).toBe('adjustmentIn');
    expect(ledgerKind('adjustment', -5)).toBe('adjustmentOut');
    expect(ledgerKind('delivery_fee', -20)).toBe('deliveryFee');
    expect(ledgerKind('delivery_fee', 20)).toBe('deliveryRefund');
    expect(ledgerKind('reward_credit', 3)).toBe('reward');
    expect(ledgerKind('voucher_claim', 3)).toBe('voucher');
    expect(ledgerKind('daily_reward', 1)).toBe('dailyReward');
    expect(ledgerKind('referral_commission', 7)).toBe('referral');
  });

  it('an unknown reason is shown as itself, never hidden', () => {
    expect(ledgerKind('something_new', 1)).toBe('other');
  });
});

describe('WALLET_FILTERS', () => {
  // Each reason sits in exactly one filter, so "All" is the sum of the rest.
  it('cover every reason exactly once', () => {
    const listed = Object.values(WALLET_FILTERS).flatMap(
      (r): readonly string[] => r ?? [],
    );
    expect([...listed].sort()).toEqual([...REASONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(WALLET_FILTERS.all).toBeNull();
  });
});
