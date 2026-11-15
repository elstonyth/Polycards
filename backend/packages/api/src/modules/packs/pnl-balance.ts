// The P&L report's point-in-time folds (spec plans/pnl-report/SPEC.md §9-10,
// decisions 14-16 and 21): unsold stock and customer floating money, as of
// now, in integer sen. The range is ignored; the SQL is
// api/admin/profit-report/pnl/queries-balance.ts.
import { playthroughState, withdrawableCents } from './withdrawable';

/** Where unused free credit came from (decision 21, bonus-fifo-proof.sql). */
export const BONUS_SOURCES = [
  'adjustment',
  'checkin',
  'task',
  'weekly_challenge',
  'returned',
  // A Lucky Draw credit prize not yet spent (review F3): its own line, not 'returned'.
  'lucky_draw',
] as const;
export type BonusSource = (typeof BONUS_SOURCES)[number];

/** One card's shelf counts (inventory-view.ts): on hand = received − shipped;
 *  requested and ready to ship are units held for open delivery orders. */
export type StockRow = {
  handle: string;
  on_hand: number;
  requested: number;
  ready_to_ship: number;
};

export type AssetsSection = {
  /** Unsold cards at weighted-average supplier cost. */
  total_sen: number;
  cards: number;
  /** Unsold cards with no supplier cost: counted, not valued. */
  no_cost_cards: number;
};

/** Unsold stock (decision 16): max(0, on hand − requested − ready to ship) per
 *  card × its weighted-average cost in RM (inventory-cost.ts, null = none). */
export function assetsSection(
  stock: readonly StockRow[],
  costs: ReadonlyMap<string, number | null>,
): AssetsSection {
  const out: AssetsSection = { total_sen: 0, cards: 0, no_cost_cards: 0 };
  for (const s of stock) {
    const n = Math.max(0, s.on_hand - s.requested - s.ready_to_ship);
    if (n === 0) continue;
    out.cards += n;
    const cost = costs.get(s.handle) ?? null;
    if (cost === null) out.no_cost_cards += n;
    else out.total_sen += Math.round(cost * 100) * n;
  }
  return out;
}

/** One customer's ledger sums in sen — walletSummary's inputs. */
export type WalletRow = {
  balance_sen: number;
  bonus_sen: number;
  /** Playthrough basis (DEPOSITED_PT_SEN_SQL) and what packs used of it. */
  deposited_sen: number;
  used_sen: number;
  has_topup: boolean;
  frozen: boolean;
};

export type CardsLine = { cards: number; sen: number };

export type FloatingSection = {
  wallet: {
    /** What each customer could cash out now (walletSummary's rule). */
    withdrawable_sen: number;
    /** Unused bonus credit: spend-only. */
    free_credit_sen: number;
    /** The same, oldest-grant-first by where it came from. */
    free_credit_by_source: Record<BonusSource, number>;
    /** Normal credit that may not leave yet: still to play through, frozen,
     *  or never topped up. */
    locked_sen: number;
    non_withdrawable_sen: number;
    total_sen: number;
  };
  /** At the vault sell-back value (decision 15). */
  cards: { vault: CardsLine; processing: CardsLine; total_sen: number };
  /** Wallets + cards. */
  total_sen: number;
};

/** Customer floating money (decision 14): each wallet through the same
 *  playthrough gate walletSummary uses, the rest split into bonus and locked
 *  cash, plus cards in vaults and in open delivery orders. A negative balance
 *  or bonus owes nobody anything (profitOwed's clamp). */
export function floatingSection(
  wallets: readonly WalletRow[],
  freeCreditBySource: Record<BonusSource, number>,
  cards: { vault: CardsLine; processing: CardsLine },
): FloatingSection {
  let withdrawable = 0;
  let bonus = 0;
  let locked = 0;
  for (const w of wallets) {
    const b = Math.max(0, w.bonus_sen);
    const normal = Math.max(0, w.balance_sen - w.bonus_sen);
    const { remainingCents } = playthroughState({
      depositedCents: w.deposited_sen,
      usedCents: w.used_sen,
    });
    const out = w.has_topup
      ? withdrawableCents({
          availableCents: w.frozen ? 0 : w.balance_sen,
          bonusCents: b,
          remainingCents,
        })
      : 0;
    withdrawable += out;
    bonus += b;
    locked += normal - out;
  }
  const walletTotal = withdrawable + bonus + locked;
  const cardsTotal = cards.vault.sen + cards.processing.sen;
  return {
    wallet: {
      withdrawable_sen: withdrawable,
      free_credit_sen: bonus,
      free_credit_by_source: { ...freeCreditBySource },
      locked_sen: locked,
      non_withdrawable_sen: bonus + locked,
      total_sen: walletTotal,
    },
    cards: { ...cards, total_sen: cardsTotal },
    total_sen: walletTotal + cardsTotal,
  };
}
