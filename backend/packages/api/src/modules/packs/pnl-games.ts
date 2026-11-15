// The P&L report's Coin flip and Lucky Draw sections (spec plans/pnl-report/
// SPEC.md §3-4, decisions 1, 3, 4, 13). Pure folds; amounts are integer sen,
// tickets are counts and never enter an RM total.
import { FLAT_PERCENT } from './buyback-rate';
import {
  rateOn,
  type DayRate,
  type PackMeta,
  type PackRow,
  type Pair,
} from './pnl';

/** A count with the window before; previous is null for range=all. */
export type Count = { current: number; previous: number | null };

/** One window's raw coin flip and Lucky Draw rows (queries-games.ts). */
export type GamesWindowRows = {
  coin_flip: {
    /** Settled card flips (ledger_entry CF rows). */
    card_flips: number;
    /** Every card lost at its flip value, reward cards included (decision 23). */
    lost_sen: number;
    /** Every card staked, won or lost, at its flip value (payload cards). */
    bet_sen: number;
    /** Credit paid on wins (credit_transaction coin_flip_win). */
    win_sen: number;
    /** Flips that staked tickets alone (a coin_flip ticket row with no CF row). */
    ticket_only_flips: number;
  };
  /** Capsule pack_open charges at full price (cash + bonus share), by capsule. */
  capsules: { slug: string; full_sen: number; bonus_sen: number }[];
  /** Capsule spins (ticket_spin rows), by capsule. */
  spins: { slug: string; n: number }[];
  /** Lucky Draw credit prizes paid. */
  credit_prizes: { n: number; sen: number };
  /** Lucky Draw card prizes minted, display value in USD, by MYT draw day. */
  card_prizes: { day: string; n: number; usd: number }[];
  /** lucky_draw_ticket rows by reason: positive deltas given, negative spent. */
  tickets: { reason: string; given: number; spent: number }[];
};

export type CoinFlipSection = {
  /** Cards players lost (revenue). */
  revenue: Pair;
  /** Credit paid on wins (COGS). */
  cost: Pair;
  /** Information: every card staked, won + lost. */
  bet_value: Pair;
  flips: Count;
  /** Tickets players lost (revenue side, a count). */
  tickets_lost: Count;
  /** Tickets paid on wins (cost side, a count). */
  tickets_won: Count;
};

export type CapsuleFigures = {
  spins: number;
  sales_sen: number;
  bonus_sen: number;
};

/** Owner's order: where tickets come from, then refunds, then what spends them. */
export const TICKET_REASONS = [
  'pack_spin',
  'task_claim',
  'coin_flip',
  'admin_grant',
  'refund',
  'entry',
] as const;

export type LuckyDrawSection = {
  /** Capsule sales at full price (revenue). */
  revenue: Pair;
  capsules: PackRow<CapsuleFigures>[];
  /** Prizes given (COGS) = credit prizes + card prizes. */
  cost: Pair;
  credit_prizes: Pair;
  card_prizes: Pair;
  prize_count: { credit: Count; card: Count };
  tickets: { reason: string; given: Count; spent: Count }[];
};

const pair = (cur: number, prev: number | null): Pair => ({
  current_sen: cur,
  previous_sen: prev,
});
const count = (cur: number, prev: number | null): Count => ({
  current: cur,
  previous: prev,
});
const ticketsOf = (w: GamesWindowRows, reason: string) =>
  w.tickets.find((t) => t.reason === reason) ?? { given: 0, spent: 0 };

/** Coin flip (decision 4): revenue = cards lost, cost = win credit. Tickets
 *  staked in flips are counts beside them. */
export function coinFlipSection(
  current: GamesWindowRows,
  previous: GamesWindowRows | null,
): CoinFlipSection {
  const of = (pick: (w: GamesWindowRows) => number) =>
    [pick(current), previous ? pick(previous) : null] as const;
  const flips = (w: GamesWindowRows) =>
    w.coin_flip.card_flips + w.coin_flip.ticket_only_flips;
  return {
    revenue: pair(...of((w) => w.coin_flip.lost_sen)),
    cost: pair(...of((w) => w.coin_flip.win_sen)),
    bet_value: pair(...of((w) => w.coin_flip.bet_sen)),
    flips: count(...of(flips)),
    tickets_lost: count(...of((w) => ticketsOf(w, 'coin_flip').spent)),
    tickets_won: count(...of((w) => ticketsOf(w, 'coin_flip').given)),
  };
}

/** Every capsule a window names, for packMeta. */
export function capsuleSlugsOf(
  ...windows: (GamesWindowRows | null)[]
): string[] {
  const s = new Set<string>();
  for (const w of windows) {
    if (!w) continue;
    for (const c of w.capsules) s.add(c.slug);
    for (const c of w.spins) s.add(c.slug);
  }
  return [...s];
}

function capsuleFigures(w: GamesWindowRows, slug: string): CapsuleFigures {
  const sale = w.capsules.find((c) => c.slug === slug);
  return {
    spins: w.spins.find((c) => c.slug === slug)?.n ?? 0,
    sales_sen: sale?.full_sen ?? 0,
    bonus_sen: sale?.bonus_sen ?? 0,
  };
}

// shortcut: a prize card has no draw-time value (reward pulls carry no
// recorded_value_usd), so the query reads today's card price and a closed
// month's figure moves with it; snapshot it at payout if that matters.
/** Card prizes at the vault buyback rate (display value × FLAT_PERCENT), each
 *  draw day at that day's saved rate. */
const cardPrizeSen = (
  w: GamesWindowRows,
  rates: readonly DayRate[],
  fallback: number,
) =>
  w.card_prizes.reduce(
    (n, p) =>
      n + Math.round(p.usd * rateOn(p.day, rates, fallback) * FLAT_PERCENT),
    0,
  );

/** Lucky Draw: capsule sales by capsule (decision 3, only here, full price)
 *  and prizes given (decision 1, COGS); tickets by reason as counts. */
export function luckyDrawSection(
  meta: readonly PackMeta[],
  current: GamesWindowRows,
  previous: GamesWindowRows | null,
  rates: readonly DayRate[],
  fallbackRate: number,
): LuckyDrawSection {
  const bySlug = new Map(meta.map((m) => [m.slug, m]));
  const capsules = capsuleSlugsOf(current, previous)
    .map((slug): PackRow<CapsuleFigures> => {
      const m = bySlug.get(slug);
      return {
        slug,
        title: m?.title ?? slug,
        price_sen: m?.price_sen ?? 0,
        current: capsuleFigures(current, slug),
        previous: previous ? capsuleFigures(previous, slug) : null,
      };
    })
    .sort(
      (a, b) => a.price_sen - b.price_sen || a.title.localeCompare(b.title),
    );

  const sales = (w: GamesWindowRows) =>
    w.capsules.reduce((n, c) => n + c.full_sen, 0);
  const card = (w: GamesWindowRows) => cardPrizeSen(w, rates, fallbackRate);
  const of = (pick: (w: GamesWindowRows) => number) =>
    [pick(current), previous ? pick(previous) : null] as const;

  const reasons = [
    ...TICKET_REASONS,
    ...[...current.tickets, ...(previous?.tickets ?? [])]
      .map((t) => t.reason)
      .filter((r) => !(TICKET_REASONS as readonly string[]).includes(r)),
  ];
  return {
    revenue: pair(...of(sales)),
    capsules,
    cost: pair(...of((w) => w.credit_prizes.sen + card(w))),
    credit_prizes: pair(...of((w) => w.credit_prizes.sen)),
    card_prizes: pair(...of(card)),
    prize_count: {
      credit: count(...of((w) => w.credit_prizes.n)),
      card: count(...of((w) => w.card_prizes.reduce((n, p) => n + p.n, 0))),
    },
    tickets: [...new Set(reasons)].map((reason) => ({
      reason,
      given: count(...of((w) => ticketsOf(w, reason).given)),
      spent: count(...of((w) => ticketsOf(w, reason).spent)),
    })),
  };
}
