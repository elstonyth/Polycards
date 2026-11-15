// The P&L report's Marketing section (spec plans/pnl-report/SPEC.md §7,
// decisions 2, 6, 11, 12, 20, 21). Pure fold over the rows from
// api/admin/profit-report/pnl/queries-marketing.ts; integer sen throughout.
import { FLAT_PERCENT } from './buyback-rate';
import {
  FREE_SOURCES,
  type FreeSource,
  type Pair,
  type PackMeta,
  type PackWindowRows,
  type DayRate,
  rateOn,
} from './pnl';

/** Where a bonus credit lot came from (decision 21, oldest grant first).
 *  `returned` = bonus coming back (sell-back of a bonus-bought card, a
 *  delivery-fee refund). `lucky_draw` = a Lucky Draw credit prize: Lucky Draw
 *  cost, so it never enters the marketing total. */
export const CREDIT_SOURCES = [
  'adjustment',
  'checkin',
  'task',
  'weekly_challenge',
  'returned',
  'lucky_draw',
  'other',
] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];

/** Free credit handed out as marketing (what "given" adds up). */
const GIVEN_SOURCES: readonly CreditSource[] = [
  'adjustment',
  'checkin',
  'task',
  'weekly_challenge',
  'other',
];

/** Reward CARDS that are marketing. Lucky Draw card prizes are Lucky Draw cost. */
export const CARD_SOURCES = ['checkin', 'task', 'weekly_challenge'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

/** One window's raw marketing rows. */
export const CASH_REWARD_SOURCES = [
  'checkin',
  'task',
  'weekly_challenge',
  'other',
] as const;
export type CashRewardSource = (typeof CASH_REWARD_SOURCES)[number];

export type MarketingWindowRows = {
  /** used = bonus spent in the window by the lot it came from; given = bonus
   *  lots created in the window; removed = admin bonus removals (negative
   *  bonus_grant), which consume lots but are not "used". */
  credit: {
    kind: 'used' | 'given' | 'removed';
    source: CreditSource;
    sen: number;
  }[];
  /** Reward cards given in the window (pull.rolled_at): sold = already sold
   *  back (sold_sen = the RM credited); unsold_usd = live value of the rest. */
  cards: {
    source: CardSource;
    n: number;
    sold: number;
    sold_sen: number;
    unsold_usd: number;
    /** MYT day given, for that day's saved rate; absent = the current rate. */
    day?: string;
  }[];
  referral_sen: number;
  /** Cash part of reward credits given in the window (decision 24: before
   *  11 Oct every reward was cash), by the credit's source. */
  cash_rewards: { source: CreditSource; sen: number }[];
};

export type FreePackRow = {
  slug: string;
  title: string;
  price_sen: number;
  /** Current window. */
  qty: Record<FreeSource, number>;
  value: Pair;
};

export type MarketingSection = {
  /** credit_used + free_cards + free_packs + referral. */
  total: Pair;
  /** In the total; lucky_draw is shown but left out of `total`. */
  credit_used: {
    total: Pair;
    by_source: Record<CreditSource, Pair>;
    /** Free credit that came back by a refund or reversal: taken off total. */
    returned_back: Pair;
  };
  /** Information only: adding it to the total would count bonus twice. */
  credit_given: {
    total: Pair;
    by_source: Record<CreditSource, Pair>;
    removed: Pair;
  };
  free_cards: {
    total: Pair;
    /** cards/sold: current window. */
    by_source: Record<CardSource, { cards: number; sold: number; value: Pair }>;
  };
  free_packs: { total: Pair; packs: FreePackRow[] };
  referral: Pair;
  /** Reward credits paid as cash, counted when given (decision 24). */
  cash_rewards: { total: Pair; by_source: Record<CashRewardSource, Pair> };
};

const pair = (cur: number, prev: number | null): Pair => ({
  current_sen: cur,
  previous_sen: prev,
});

const sumPairs = (ps: readonly Pair[], hasPrevious: boolean): Pair =>
  pair(
    ps.reduce((n, p) => n + p.current_sen, 0),
    hasPrevious ? ps.reduce((n, p) => n + (p.previous_sen ?? 0), 0) : null,
  );

const creditSen = (
  w: MarketingWindowRows,
  kind: MarketingWindowRows['credit'][number]['kind'],
  source: CreditSource,
) =>
  w.credit
    .filter((r) => r.kind === kind && r.source === source)
    .reduce((n, r) => n + r.sen, 0);

// Sold cards at the RM actually credited; the rest at the vault sell-back
// rate on live value (FLAT_PERCENT, the profitOwed basis) at the day given's
// saved rate. USD × rate × % = sen.
// shortcut: reward pulls carry no draw-time card value, so the USD is today's
// price and a closed month still moves with card prices; snapshot at payout to fix.
const cardSen = (
  w: MarketingWindowRows,
  source: CardSource,
  fx: number,
  rates: readonly DayRate[],
) =>
  w.cards
    .filter((c) => c.source === source)
    .reduce(
      (n, c) =>
        n +
        c.sold_sen +
        Math.round(
          c.unsold_usd * rateOn(c.day ?? '', rates, fx) * FLAT_PERCENT,
        ),
      0,
    );

const freeQty = (free: PackWindowRows['free'], slug: string) => {
  const q = Object.fromEntries(FREE_SOURCES.map((s) => [s, 0])) as Record<
    FreeSource,
    number
  >;
  for (const f of free) if (f.slug === slug) q[f.source] += f.qty;
  return q;
};

// Welcome packs count at RM 0 (decision 20): qty only.
const freeSen = (q: Record<FreeSource, number>, priceSen: number) =>
  FREE_SOURCES.reduce((n, s) => n + (s === 'welcome' ? 0 : q[s] * priceSen), 0);

/** Marketing (expenses): free credit used by source, free cards, free packs
 *  (the same packs and price as Pack sales, so they cancel — decision 2) and
 *  referral commission. `fx` = the current effective USD_MYR rate. */
export function marketingSection(
  meta: readonly PackMeta[],
  packsCurrent: PackWindowRows,
  packsPrevious: PackWindowRows | null,
  current: MarketingWindowRows,
  previous: MarketingWindowRows | null,
  fx: number,
  rates: readonly DayRate[] = [],
): MarketingSection {
  const has = previous !== null;
  const bySource = (kind: 'used' | 'given') =>
    Object.fromEntries(
      CREDIT_SOURCES.map((s) => [
        s,
        pair(
          creditSen(current, kind, s),
          previous ? creditSen(previous, kind, s) : null,
        ),
      ]),
    ) as Record<CreditSource, Pair>;

  const used = bySource('used');
  const given = bySource('given');
  // Free credit that came back by an undo (an open reversed, a delivery fee
  // refunded) is not new promo: the first spend already counted, so what came
  // back is taken off and a re-spend is not a second cost (review F1).
  const returnedBack = given.returned;
  const creditUsed = {
    total: sumPairs(
      [
        ...CREDIT_SOURCES.filter((s) => s !== 'lucky_draw').map((s) => used[s]),
        pair(
          -returnedBack.current_sen,
          returnedBack.previous_sen === null
            ? null
            : -returnedBack.previous_sen,
        ),
      ],
      has,
    ),
    by_source: used,
    returned_back: returnedBack,
  };
  const creditGiven = {
    total: sumPairs(
      GIVEN_SOURCES.map((s) => given[s]),
      has,
    ),
    by_source: given,
    removed: pair(
      creditSen(current, 'removed', 'adjustment'),
      previous ? creditSen(previous, 'removed', 'adjustment') : null,
    ),
  };

  const cards = Object.fromEntries(
    CARD_SOURCES.map((s) => {
      const rows = current.cards.filter((c) => c.source === s);
      return [
        s,
        {
          cards: rows.reduce((n, c) => n + c.n, 0),
          sold: rows.reduce((n, c) => n + c.sold, 0),
          value: pair(
            cardSen(current, s, fx, rates),
            previous ? cardSen(previous, s, fx, rates) : null,
          ),
        },
      ];
    }),
  ) as MarketingSection['free_cards']['by_source'];
  const freeCards = {
    total: sumPairs(
      CARD_SOURCES.map((s) => cards[s].value),
      has,
    ),
    by_source: cards,
  };

  const bySlug = new Map(meta.map((m) => [m.slug, m]));
  const slugs = [
    ...new Set(
      [...packsCurrent.free, ...(packsPrevious?.free ?? [])].map((f) => f.slug),
    ),
  ];
  const packs: FreePackRow[] = [];
  for (const slug of slugs) {
    const m = bySlug.get(slug);
    // Capsules belong to Lucky Draw, as in Pack sales.
    if (m?.prize_type === 'tickets') continue;
    const price = m?.price_sen ?? 0;
    const qty = freeQty(packsCurrent.free, slug);
    packs.push({
      slug,
      title: m?.title ?? slug,
      price_sen: price,
      qty,
      value: pair(
        freeSen(qty, price),
        packsPrevious
          ? freeSen(freeQty(packsPrevious.free, slug), price)
          : null,
      ),
    });
  }
  packs.sort(
    (a, b) =>
      b.value.current_sen - a.value.current_sen ||
      a.title.localeCompare(b.title),
  );
  const freePacks = {
    total: sumPairs(
      packs.map((p) => p.value),
      !!packsPrevious,
    ),
    packs,
  };

  const referral = pair(
    current.referral_sen,
    previous ? previous.referral_sen : null,
  );
  const cashOf = (w: MarketingWindowRows, k: CashRewardSource) =>
    w.cash_rewards
      .filter((r) =>
        k === 'other'
          ? !(CASH_REWARD_SOURCES as readonly string[]).includes(r.source)
          : r.source === k,
      )
      .reduce((n, r) => n + r.sen, 0);
  const cashBySource = Object.fromEntries(
    CASH_REWARD_SOURCES.map((k) => [
      k,
      pair(cashOf(current, k), previous ? cashOf(previous, k) : null),
    ]),
  ) as Record<CashRewardSource, Pair>;
  const cashRewards = {
    total: sumPairs(Object.values(cashBySource), has),
    by_source: cashBySource,
  };
  return {
    total: sumPairs(
      [
        creditUsed.total,
        freeCards.total,
        freePacks.total,
        referral,
        cashRewards.total,
      ],
      has,
    ),
    credit_used: creditUsed,
    credit_given: creditGiven,
    free_cards: freeCards,
    free_packs: freePacks,
    referral,
    cash_rewards: cashRewards,
  };
}
