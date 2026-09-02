import { ledgerTotals } from '../economy';
import { CreditTransaction } from '../models/credit-transaction';

// Task A5 — reward reasons must land in the non-revenue rewardPromo bucket
// and must NOT affect net / revenue.

describe('ledgerTotals — reward reasons', () => {
  it('puts reward_credit amount into rewardPromo, not revenue/net', () => {
    const result = ledgerTotals([{ reason: 'reward_credit', amount: 10 }]);
    expect(result.rewardPromo).toBe(10);
    expect(result.revenue).toBe(0);
    expect(result.net).toBe(0);
  });

  it('puts voucher_claim amount into rewardPromo, not revenue/net', () => {
    const result = ledgerTotals([{ reason: 'voucher_claim', amount: 5 }]);
    expect(result.rewardPromo).toBe(5);
    expect(result.revenue).toBe(0);
    expect(result.net).toBe(0);
  });

  it('sums both reward reasons into rewardPromo independently of revenue', () => {
    const result = ledgerTotals([
      { reason: 'pack_open', amount: -100 },
      { reason: 'buyback', amount: 20 },
      { reason: 'voucher_claim', amount: 5 },
      { reason: 'reward_credit', amount: 3 },
    ]);
    expect(result.rewardPromo).toBe(8);
    expect(result.revenue).toBe(100);
    // net = revenue - payouts - commissions (rewardPromo excluded)
    expect(result.net).toBe(80);
  });

  it('returns zero rewardPromo on an empty ledger', () => {
    expect(ledgerTotals([]).rewardPromo).toBe(0);
  });
});

// Every reason the ledger can hold MUST have a bucket: ledgerTotals throws on
// an unknown one (by design), and /admin/economy feeds it a plain GROUP BY
// reason — so a reason added to the model but not here 500s the whole report
// the moment one row exists. This pins the enum and the fold together so the
// next new reason fails HERE, not in prod.
describe('ledgerTotals — every credit_transaction.reason has a bucket', () => {
  it('folds every enum choice without throwing', () => {
    const meta = CreditTransaction.schema.reason.parse('reason') as {
      dataType: { options?: { choices?: string[] } };
    };
    const choices = meta.dataType.options?.choices ?? [];
    expect(choices.length).toBeGreaterThan(0);
    for (const reason of choices) {
      expect(() => ledgerTotals([{ reason, amount: 1 }])).not.toThrow();
    }
  });
});

describe('ledgerTotals — delivery_fee', () => {
  it('reports fees collected as a positive line, net of cancel refunds, outside pack revenue/net', () => {
    const result = ledgerTotals([
      { reason: 'delivery_fee', amount: -15 }, // charged at request
      { reason: 'delivery_fee', amount: 15 }, // refunded on cancel
      { reason: 'delivery_fee', amount: -20 },
    ]);
    expect(result.deliveryFees).toBe(20);
    expect(result.revenue).toBe(0);
    expect(result.net).toBe(0);
  });
});

describe('ledgerTotals — referral_commission', () => {
  it('reports the weekly payout as operator promo cost, outside revenue/net', () => {
    const result = ledgerTotals([
      { reason: 'pack_open', amount: -100 },
      { reason: 'referral_commission', amount: 2.5 },
    ]);
    expect(result.referralCommission).toBe(2.5);
    expect(result.rewardPromo).toBe(0);
    expect(result.revenue).toBe(100);
    expect(result.net).toBe(100);
  });
});
