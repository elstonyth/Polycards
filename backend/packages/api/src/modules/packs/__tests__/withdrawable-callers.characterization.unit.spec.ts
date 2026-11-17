/**
 * The two folds of the withdrawable rule, pinned over one matrix of ledger
 * facts: walletSummary (the figure both withdrawal gates read) and the P&L
 * floating-money section. Both must say the same thing for the same wallet.
 */
import PacksModuleService from '../service';
import { floatingSection, BONUS_SOURCES, type WalletRow } from '../pnl-balance';

type Facts = Omit<WalletRow, 'frozen'> & { frozen: boolean };

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
];

async function viaWalletSummary(f: Facts): Promise<number> {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  (svc as unknown as { isFrozen: () => Promise<boolean> }).isFrozen =
    async () => f.frozen;
  const wallet = await svc.walletSummary(
    'cus_1',
    {
      balance: f.balance_sen / 100,
      depositedCents: f.deposited_sen,
      usedCents: f.used_sen,
      // walletSummary's own scan clamps the bonus sum at 0 before passing it.
      bonusCents: Math.max(0, f.bonus_sen),
      hasTopup: f.has_topup,
    },
    { manager: { execute: async () => [] } } as never,
  );
  return Math.round(wallet.withdrawable * 100);
}

function viaPnl(f: Facts): number {
  const empty = Object.fromEntries(BONUS_SOURCES.map((s) => [s, 0])) as never;
  const none = { cards: 0, sen: 0 };
  return floatingSection([f], empty, { vault: none, processing: none }).wallet
    .withdrawable_sen;
}

test.each(MATRIX)('%s: both folds agree', async (_name, over) => {
  const facts = { ...base, ...over };
  const pnl = viaPnl(facts);
  await expect(viaWalletSummary(facts)).resolves.toBe(pnl);
});

// The figures themselves, so a change to the rule is a visible change here.
test('the pinned answers', () => {
  expect(
    Object.fromEntries(
      MATRIX.map(([name, over]) => [name, viaPnl({ ...base, ...over })]),
    ),
  ).toEqual({
    'played through, no bonus': 10_000,
    'odd sen balance': 10_001,
    'one sen': 1,
    'odd sen balance and bonus': 222,
    'bonus inside balance': 7_500,
    'bonus larger than balance': 0,
    'negative bonus': 10_000,
    frozen: 0,
    'frozen with bonus': 0,
    'no top-up': 0,
    'no top-up with bonus': 0,
    'zero balance': 0,
    'negative balance': 0,
    'one sen still to play': 0,
    'over-played': 10_000,
    'nothing played': 0,
    'still to play and frozen': 0,
    'large balance': 123_456_782,
  });
});
