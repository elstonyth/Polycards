/**
 * The two folds of the withdrawable rule, pinned over one matrix of ledger
 * facts: walletSummary (the figure both withdrawal gates read) and the P&L
 * floating-money section. The inline snapshots were written against the code
 * BEFORE walletWithdrawable existed, so they pin what each caller answered
 * then, field by field.
 */
import PacksModuleService from '../service';
import { floatingSection, BONUS_SOURCES } from '../pnl-balance';

type Facts = {
  balance_sen: number;
  bonus_sen: number;
  deposited_sen: number;
  used_sen: number;
  has_topup: boolean;
  frozen: boolean;
  /** walletSummary only: a precomputed balance that is not whole sen. */
  balance_myr?: number;
};

const base: Facts = {
  balance_sen: 10_000,
  bonus_sen: 0,
  deposited_sen: 5_000,
  used_sen: 5_000,
  has_topup: true,
  frozen: false,
};

const MATRIX: [string, Partial<Facts>][] = [
  ['played through, no bonus', {}],
  ['odd sen balance', { balance_sen: 10_001 }],
  ['one sen', { balance_sen: 1 }],
  ['odd sen balance and bonus', { balance_sen: 333, bonus_sen: 111 }],
  ['bonus inside balance', { bonus_sen: 2_500 }],
  ['bonus larger than balance', { balance_sen: 1_000, bonus_sen: 1_500 }],
  ['negative bonus', { bonus_sen: -300 }],
  ['frozen', { frozen: true }],
  ['frozen with bonus', { frozen: true, bonus_sen: 2_500 }],
  ['no top-up', { has_topup: false }],
  ['no top-up with bonus', { has_topup: false, bonus_sen: 2_500 }],
  ['zero balance', { balance_sen: 0 }],
  ['negative balance', { balance_sen: -500 }],
  ['one sen still to play', { used_sen: 4_999 }],
  ['over-played', { used_sen: 5_001 }],
  ['nothing played', { used_sen: 0 }],
  ['still to play and frozen', { used_sen: 0, frozen: true }],
  ['large balance', { balance_sen: 123_456_789, bonus_sen: 7 }],
  ['half a sen above', { balance_myr: 100.005 }],
  ['a hair under a sen', { balance_myr: 100.0049 }],
];

/** Inputs no current caller can produce, where the folds differ: walletSummary
 *  takes a precomputed bonus as given (both of its feeders clamp it at 0
 *  first), the P&L clamps its own. Pinned below, not asserted equal. */
const CALLERS_DIFFER = new Set(['negative bonus']);

async function viaWalletSummary(f: Facts) {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  (svc as unknown as { isFrozen: () => Promise<boolean> }).isFrozen =
    async () => f.frozen;
  return svc.walletSummary(
    'cus_1',
    {
      balance: f.balance_myr ?? f.balance_sen / 100,
      depositedCents: f.deposited_sen,
      usedCents: f.used_sen,
      bonusCents: f.bonus_sen,
      hasTopup: f.has_topup,
    },
    { manager: { execute: async () => [] } } as never,
  );
}

function viaPnl(f: Facts) {
  const empty = Object.fromEntries(BONUS_SOURCES.map((s) => [s, 0])) as never;
  const none = { cards: 0, sen: 0 };
  const { withdrawable_sen, free_credit_sen, locked_sen } = floatingSection(
    [f],
    empty,
    { vault: none, processing: none },
  ).wallet;
  return { withdrawable_sen, free_credit_sen, locked_sen };
}

const facts = (over: Partial<Facts>): Facts => ({ ...base, ...over });

test.each(MATRIX.filter(([n, o]) => !CALLERS_DIFFER.has(n) && !o.balance_myr))(
  '%s: both folds agree on what may leave',
  async (_name, over) => {
    const wallet = await viaWalletSummary(facts(over));
    expect(Math.round(wallet.withdrawable * 100)).toBe(
      viaPnl(facts(over)).withdrawable_sen,
    );
  },
);

test('walletSummary answers, field by field', async () => {
  const out: Record<string, unknown> = {};
  for (const [name, over] of MATRIX) {
    const w = await viaWalletSummary(facts(over));
    out[name] = [
      w.available,
      w.withdrawable,
      w.bonus,
      w.playthrough.remaining,
      w.isFrozen,
      w.hasTopup,
    ].join(' ');
  }
  expect(out).toMatchInlineSnapshot(`
    {
      "a hair under a sen": "100 100 0 0 false true",
      "bonus inside balance": "100 75 25 0 false true",
      "bonus larger than balance": "10 0 15 0 false true",
      "frozen": "0 0 0 0 true true",
      "frozen with bonus": "0 0 25 0 true true",
      "half a sen above": "100.01 100.01 0 0 false true",
      "large balance": "1234567.89 1234567.82 0.07 0 false true",
      "negative balance": "-5 0 0 0 false true",
      "negative bonus": "100 103 -3 0 false true",
      "no top-up": "100 0 0 0 false false",
      "no top-up with bonus": "100 0 25 0 false false",
      "nothing played": "100 0 0 50 false true",
      "odd sen balance": "100.01 100.01 0 0 false true",
      "odd sen balance and bonus": "3.33 2.22 1.11 0 false true",
      "one sen": "0.01 0.01 0 0 false true",
      "one sen still to play": "100 0 0 0.01 false true",
      "over-played": "100 100 0 0 false true",
      "played through, no bonus": "100 100 0 0 false true",
      "still to play and frozen": "0 0 0 50 true true",
      "zero balance": "0 0 0 0 false true",
    }
  `);
});

test('P&L answers, field by field', () => {
  const out: Record<string, unknown> = {};
  for (const [name, over] of MATRIX) {
    if (over.balance_myr) continue;
    const p = viaPnl(facts(over));
    out[name] = [p.withdrawable_sen, p.free_credit_sen, p.locked_sen].join(' ');
  }
  expect(out).toMatchInlineSnapshot(`
    {
      "bonus inside balance": "7500 2500 0",
      "bonus larger than balance": "0 1500 0",
      "frozen": "0 0 10000",
      "frozen with bonus": "0 2500 7500",
      "large balance": "123456782 7 0",
      "negative balance": "0 0 0",
      "negative bonus": "10000 0 300",
      "no top-up": "0 0 10000",
      "no top-up with bonus": "0 2500 7500",
      "nothing played": "0 0 10000",
      "odd sen balance": "10001 0 0",
      "odd sen balance and bonus": "222 111 0",
      "one sen": "1 0 0",
      "one sen still to play": "0 0 10000",
      "over-played": "10000 0 0",
      "played through, no bonus": "10000 0 0",
      "still to play and frozen": "0 0 10000",
      "zero balance": "0 0 0",
    }
  `);
});
