import { describe, it, expect } from 'vitest';
import {
  parseList,
  parseOne,
  PackRowSchema,
  OddsEntrySchema,
  RecentPullSchema,
  LeaderboardEntrySchema,
  PublicProfileSchema,
  CreditTransactionSchema,
  VaultItemSchema,
  BalanceSchema,
  WonCardSchema,
  OpenBuybackSchema,
  BuybackResultSchema,
  CardDetailSchema,
  WalletSchema,
  CREDIT_REASONS,
} from '../schemas';

describe('parseList — drops invalid items, never throws', () => {
  it('returns [] for non-arrays (mirrors Array.isArray guard)', () => {
    expect(parseList(PackRowSchema, null)).toEqual([]);
    expect(parseList(PackRowSchema, undefined)).toEqual([]);
    expect(parseList(PackRowSchema, {})).toEqual([]);
  });

  it('keeps valid pack rows, drops bad category/price (passes extra fields through)', () => {
    const rows = [
      { slug: 'a', category: 'pokemon', price: 10, title: 'A' },
      { slug: 'b', category: 42, price: 10 }, // non-string category → drop
      { slug: 'c', category: 'pokemon', price: NaN }, // non-finite price → drop
      { slug: 'd', category: 'pokemon', price: Infinity }, // → drop
      null, // → drop
    ];
    const out = parseList(PackRowSchema, rows);
    expect(out.map((r) => (r as unknown as { slug: string }).slug)).toEqual([
      'a',
    ]);
    expect((out[0] as unknown as { title: string }).title).toBe('A'); // looseObject passthrough
  });

  it('OddsEntry drops unknown rarity + non-finite value', () => {
    const out = parseList(OddsEntrySchema, [
      { handle: 'x', rarity: 'Mythical', market_value: 5 },
      { handle: 'y', rarity: 'Nope', market_value: 5 }, // unknown rarity → drop
      { handle: 'z', rarity: 'Mythical', market_value: NaN }, // → drop
    ]);
    expect(out).toHaveLength(1);
  });

  it('RecentPull requires handle + name + rarity + finite value', () => {
    const out = parseList(RecentPullSchema, [
      { handle: 'x', name: 'X', rarity: 'Rare', market_value: 1 },
      { handle: 'y', name: 42, rarity: 'Rare', market_value: 1 }, // bad name → drop
    ]);
    expect(out).toHaveLength(1);
  });

  it('Leaderboard requires name + finite points/volume/pulls', () => {
    const out = parseList(LeaderboardEntrySchema, [
      { name: 'A', points: 1, volume: 2, pulls: 3, seed: 9 },
      { name: 'B', points: 1, volume: 2, pulls: NaN }, // → drop
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as unknown as { seed: number }).seed).toBe(9); // passthrough
  });

  it('VaultItem requires pull_id + card.name + finite buyback.amount/percent', () => {
    const good = {
      pull_id: 'p',
      card: { name: 'C' },
      buyback: { amount: 5, percent: 90 },
    };
    const out = parseList(VaultItemSchema, [
      good,
      { pull_id: 'p', card: { name: 'C' } }, // missing buyback → drop
      { pull_id: 'p', card: {}, buyback: { amount: 5, percent: 90 } }, // missing card.name → drop
      {
        pull_id: 'p',
        card: { name: 'C' },
        buyback: { amount: NaN, percent: 90 },
      }, // → drop
    ]);
    expect(out).toHaveLength(1);
  });
});

// #6 — the buyback percent is shown the instant a customer commits money. Guard
// it at the data boundary (mirrors OpenBuybackSchema) so a dropped field becomes
// a friendly error / dropped row, never a rendered "NaN%".
describe('buyback percent guard (#6)', () => {
  it('VaultItemSchema drops items missing a finite buyback.percent', () => {
    const base = { pull_id: 'p', card: { name: 'C' } };
    const out = parseList(VaultItemSchema, [
      { ...base, buyback: { amount: 5, percent: 90 } }, // keep
      { ...base, buyback: { amount: 5 } }, // missing percent → drop
      { ...base, buyback: { amount: 5, percent: NaN } }, // → drop
    ]);
    expect(out).toHaveLength(1);
  });

  it('BuybackResultSchema requires finite amount + balance; percent optional', () => {
    expect(
      parseOne(BuybackResultSchema, { amount: 5, balance: 10, percent: 90 }),
    ).not.toBeNull();
    // percent is unused on the sell path — its absence must NOT fail the buyback.
    expect(
      parseOne(BuybackResultSchema, { amount: 5, balance: 10 }),
    ).not.toBeNull();
    // a non-finite amount/balance (the rendered fields) still rejects.
    expect(
      parseOne(BuybackResultSchema, { amount: NaN, balance: 10 }),
    ).toBeNull();
  });
});

describe('parseOne — null on failure', () => {
  it('PublicProfile needs handle string + stats object', () => {
    expect(
      parseOne(PublicProfileSchema, { handle: 'h', stats: {} }),
    ).not.toBeNull();
    expect(parseOne(PublicProfileSchema, { handle: 'h' })).toBeNull();
    expect(parseOne(PublicProfileSchema, { stats: {} })).toBeNull();
    expect(parseOne(PublicProfileSchema, null)).toBeNull();
  });

  it('Balance / WonCard / OpenBuyback', () => {
    expect(parseOne(BalanceSchema, { balance: 10 })).not.toBeNull();
    expect(parseOne(BalanceSchema, { balance: NaN })).toBeNull();
    expect(
      parseOne(WonCardSchema, {
        handle: 'h',
        name: 'N',
        rarity: 'Mythical',
        market_value: 1,
      }),
    ).not.toBeNull();
    expect(
      parseOne(WonCardSchema, {
        handle: 'h',
        name: 'N',
        rarity: 'Bad',
        market_value: 1,
      }),
    ).toBeNull();
    expect(
      parseOne(OpenBuybackSchema, { percent: 90, amount: 1 }),
    ).not.toBeNull();
    expect(parseOne(OpenBuybackSchema, { percent: 90 })).toBeNull();
  });
});

describe('CreditTransactionSchema — keeps every reason the backend emits', () => {
  it('keeps VIP commission rows (direct_referral etc.), not just the original 4', () => {
    const rows = [
      {
        id: 'a',
        amount: -25,
        reason: 'pack_open',
        created_at: '2026-06-22T00:00:00Z',
      },
      {
        id: 'b',
        amount: 1.25,
        reason: 'direct_referral',
        created_at: '2026-06-22T00:01:00Z',
      },
      {
        id: 'c',
        amount: 0.2,
        reason: 'team_override',
        created_at: '2026-06-22T00:02:00Z',
      },
      {
        id: 'd',
        amount: -1.25,
        reason: 'commission_reversal',
        created_at: '2026-06-22T00:03:00Z',
      },
      {
        id: 'e',
        amount: 5,
        reason: 'cashout',
        created_at: '2026-06-22T00:04:00Z',
      },
    ];
    // The backend ledger emits all 8 reasons; the storefront must not silently
    // drop commission rows (balance would stop reconciling to visible history).
    expect(parseList(CreditTransactionSchema, rows)).toHaveLength(5);
  });

  // Audit 2026-07-07 #11: `reason` is `z.string()`, not `z.enum(CREDIT_REASONS)`
  // — a reason the backend adds before the storefront redeploys must still
  // reach the UI (reasonLabel renders a generic fallback) instead of the row
  // vanishing from the customer's history.
  it('keeps a row whose reason is unknown to the storefront enum', () => {
    const rows = [
      {
        id: 'z',
        amount: -5,
        reason: 'refund_x',
        created_at: '2026-07-07T00:00:00Z',
      },
    ];
    expect(parseList(CreditTransactionSchema, rows)).toHaveLength(1);
    expect(parseList(CreditTransactionSchema, rows)[0]?.reason).toBe(
      'refund_x',
    );
  });
});

// Regression tripwire (plans/005), superseded by the #11 fix above: parseList()
// no longer drops a credit row just because `reason` isn't in CREDIT_REASONS
// (see the unknown-reason test above) — but CREDIT_REASONS is still the single
// list a NEW backend reason needs a label for (transactions.ts REASON_LABEL),
// so keep it in sync. BACKEND_CREDIT_REASONS mirrors the backend enum in
// backend/packages/api/src/modules/packs/models/credit-transaction.ts. When the
// backend adds a reason, add it HERE and to CREDIT_REASONS in the SAME deploy —
// these tests fail until you do.
const BACKEND_CREDIT_REASONS = [
  'buyback',
  'topup',
  'pack_open',
  'adjustment',
  'direct_referral',
  'team_override',
  'commission_reversal',
  'cashout',
  'voucher_claim',
  'reward_credit',
] as const;

describe('credit-reason enum drift guard (plans/005)', () => {
  it('storefront CREDIT_REASONS covers every backend credit reason', () => {
    for (const reason of BACKEND_CREDIT_REASONS) {
      expect(CREDIT_REASONS).toContain(reason);
    }
  });

  it('parseList keeps a CreditTransaction row for every backend reason', () => {
    const rows = BACKEND_CREDIT_REASONS.map((reason, i) => ({
      id: `r${i}`,
      amount: 1,
      reason,
      created_at: '2026-06-22T00:00:00Z',
    }));
    expect(parseList(CreditTransactionSchema, rows)).toHaveLength(
      BACKEND_CREDIT_REASONS.length,
    );
  });
});

describe('CardDetailSchema', () => {
  const valid = {
    handle: 'cd-card',
    name: 'CD Test Card PSA 10',
    set: 'Test Set',
    grader: 'PSA',
    grade: '10',
    image: '/cdn/test-card.webp',
    rarity: 'Rare',
    marketPriceMyr: 480,
    pcSyncedAt: null,
    priceHistory: [{ date: '2026-07-01T03:00:00Z', valueMyr: 432 }],
  };

  it('accepts a valid payload', () => {
    expect(parseOne(CardDetailSchema, valid)).toMatchObject(valid);
  });

  it('rejects a non-finite price (whole object -> null)', () => {
    expect(
      parseOne(CardDetailSchema, { ...valid, marketPriceMyr: NaN }),
    ).toBeNull();
  });

  it('degrades an unknown rarity to null instead of dropping the card', () => {
    expect(
      parseOne(CardDetailSchema, { ...valid, rarity: 'Bogus' })?.rarity,
    ).toBeNull();
  });

  it('degrades malformed history to [] instead of dropping the card', () => {
    expect(
      parseOne(CardDetailSchema, { ...valid, priceHistory: 'nope' })
        ?.priceHistory,
    ).toEqual([]);
  });
});

describe('WalletSchema', () => {
  const valid = {
    balance: 100,
    available: 80,
    locked: 20,
    is_frozen: false,
    next_unlock: null,
    withdrawable: 50,
    playthrough: { deposited: 60, used: 40, remaining: 20 },
  };

  it('accepts a full valid wallet', () => {
    expect(parseOne(WalletSchema, valid)).toMatchObject(valid);
  });

  it('still parses when withdrawable + playthrough are absent (deploy-skew backend)', () => {
    // Regression for plan 040: an older backend without the PR #140 fields must
    // degrade, not fail the whole wallet parse.
    const { withdrawable, playthrough, ...legacy } = valid;
    void withdrawable;
    void playthrough;
    const out = parseOne(WalletSchema, legacy);
    expect(out).not.toBeNull();
    expect(out?.withdrawable).toBeUndefined();
    expect(out?.playthrough).toBeUndefined();
  });

  it('rejects a malformed playthrough (wrong inner type -> whole object null)', () => {
    expect(
      parseOne(WalletSchema, {
        ...valid,
        playthrough: { deposited: 'nope', used: 40, remaining: 20 },
      }),
    ).toBeNull();
  });
});
