import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';
import type PacksModuleService from '../../../../modules/packs/service';
import { publicProfileFields, seedOf } from '../../../../utils/profile-handle';

// The most recently settled Weekly Challenge, as a results post shows it
// (spec docs/superpowers/specs/2026-10-04-growth-weekly-posts-design.md).
// The prizes are what settlement PAID (its challenge_payout rows), never a
// recomputation, so a post can never announce a prize nobody received. The
// pulled value is the same per-player figure settlement ranked by, for that
// week, at today's exchange rate; a prize card is valued at the display
// market price /task shows today. Public names only: an administratively
// disabled winner is left out, as on every public surface.

export type PrizeCard = {
  /** With the grade: 'Mew ex #232 · PSA 10'. */
  name: string;
  /** Without it, for a label under the slab, which shows the grade itself. */
  title: string;
  image: string | null;
  qty: number;
  /** One unit at today's display market price; null when the card is gone. */
  valueMyr: number | null;
};

export type ResultWinner = {
  /** The rank settlement paid. */
  rank: number;
  name: string;
  handle: string | null;
  /** That week's pulled value; null when the week is too old to recompute. */
  pulledMyr: number | null;
  credits: number;
  /** Most valuable first. */
  cards: PrizeCard[];
  /** Credits plus every card at today's value. */
  prizeMyr: number;
};

export type ChallengeResults = {
  weekStart: Date;
  weekEnd: Date;
  timezone: string;
  poolMyr: number | null;
  unlockedStages: number[];
  /** Paid rank order. */
  winners: ResultWinner[];
  /** Disabled winners left out. */
  hidden: number;
};

type PayoutRow = {
  customer_id: string;
  rank: number;
  kind: string;
  card_id: string;
  credits: unknown;
  snapshot: unknown;
};

type Snapshot = { qty?: number; pool_myr?: number; unlocked_stages?: number[] };

export type GroupedWinner = {
  customerId: string;
  rank: number;
  credits: number;
  cards: { cardId: string; qty: number }[];
  poolMyr: number | null;
  unlockedStages: number[];
};

/** Settlement's rows for one week as one entry per winner, in paid rank
 *  order: grouped by customer (rank is not part of the row's unique key, so
 *  the first rank seen wins, as on the admin Winners page), credits summed,
 *  each card with the pulls it minted. */
export function groupPayouts(rows: PayoutRow[]): GroupedWinner[] {
  const byCustomer = new Map<string, GroupedWinner>();
  for (const r of rows) {
    const snap = (r.snapshot ?? {}) as Snapshot;
    let w = byCustomer.get(r.customer_id);
    if (!w) {
      w = {
        customerId: r.customer_id,
        rank: r.rank,
        credits: 0,
        cards: [],
        poolMyr: typeof snap.pool_myr === 'number' ? snap.pool_myr : null,
        unlockedStages: Array.isArray(snap.unlocked_stages)
          ? snap.unlocked_stages
          : [],
      };
      byCustomer.set(r.customer_id, w);
    }
    if (r.kind === 'credits') w.credits += toMoney(r.credits ?? 0);
    else
      w.cards.push({
        cardId: r.card_id,
        qty: typeof snap.qty === 'number' ? snap.qty : 1,
      });
  }
  return [...byCustomer.values()].sort((a, b) => a.rank - b.rank);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a winner received, in RM: credits plus each card at today's value
 *  (a card with no price counts as nothing rather than as a guess). */
export const prizeValue = (credits: number, cards: PrizeCard[]): number =>
  round2(cards.reduce((sum, c) => sum + (c.valueMyr ?? 0) * c.qty, credits));

/** Most valuable first; a card with no price last. */
export const byValue = (cards: PrizeCard[]): PrizeCard[] =>
  [...cards].sort((a, b) => (b.valueMyr ?? -1) - (a.valueMyr ?? -1));

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// How far back a settled week's pulled values are recomputed: settlement is
// hourly, so the latest settled week is normally the one just ended.
const MAX_WEEKS_BACK = 12;

/** The latest settled week's results, or null before any settlement. */
export async function latestChallengeResults(
  scope: MedusaContainer,
): Promise<ChallengeResults | null> {
  const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [latest] = await packs.challengeWinnerWeeks(1);
  if (!latest) return null;
  const weekStart = new Date(latest.weekStart);
  const rows = (await packs.listChallengePayouts(
    { week_start: weekStart },
    {
      select: ['customer_id', 'rank', 'kind', 'card_id', 'credits', 'snapshot'],
      // Ten ranks × (credits + one row per card): far below this.
      take: 200,
    },
  )) as unknown as PayoutRow[];
  const grouped = groupPayouts(rows);

  // Which past week it is, for the anchor settlement ranked by.
  const settings = await packs.challengeSettings();
  const anchor = {
    timezone: settings.timezone,
    resetDay: settings.reset_day,
    resetHour: settings.reset_hour,
  };
  let weeksBack: number | null = null;
  let weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  for (let k = 1; k <= MAX_WEEKS_BACK; k++) {
    const b = await packs.challengeWeekBounds({ ...anchor, weeksBack: k });
    if (b.startUtc.getTime() === weekStart.getTime()) {
      weeksBack = k;
      weekEnd = b.endUtc;
      break;
    }
    if (b.startUtc.getTime() < weekStart.getTime()) break;
  }

  const disabled = await packs.disabledCustomerIds(
    grouped.map((w) => w.customerId),
  );
  const shown = grouped.filter((w) => !disabled.has(w.customerId));

  const ids = shown.map((w) => w.customerId);
  // Sequential, not Promise.all: two module services on one connection.
  const customers = ids.length
    ? await scope
        .resolve<ICustomerModuleService>(Modules.CUSTOMER)
        .listCustomers(
          { id: ids },
          { select: ['id', 'first_name', 'metadata'], take: ids.length },
        )
    : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const cardIds = [
    ...new Set(shown.flatMap((w) => w.cards.map((c) => c.cardId))),
  ];
  const cardRows = cardIds.length
    ? await packs.listCards(
        { id: cardIds },
        {
          select: [
            'id',
            'name',
            'image',
            'slab_image',
            'grader',
            'grade',
            'market_value',
            'market_multiplier',
          ],
          take: cardIds.length,
        },
      )
    : [];
  const fx = cardRows.length ? await resolveFxRate(packs) : 0;
  const cardById = new Map(cardRows.map((c) => [c.id, c]));

  const winners: ResultWinner[] = [];
  for (const w of shown) {
    const profile = publicProfileFields(
      customerById.get(w.customerId),
      seedOf(w.customerId),
    );
    const cards = byValue(
      w.cards.map(({ cardId, qty }) => {
        const c = cardById.get(cardId);
        if (!c)
          return {
            name: 'A prize card',
            title: 'A prize card',
            image: null,
            qty,
            valueMyr: null,
          };
        return {
          name:
            c.grader && c.grade ? `${c.name} · ${c.grader} ${c.grade}` : c.name,
          title: c.name,
          image: c.slab_image ?? c.image ?? null,
          qty,
          valueMyr: displayMarketPrice(
            toMoney(c.market_value),
            fx,
            Number(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
          ),
        };
      }),
    );
    const pulled =
      weeksBack === null
        ? null
        : (
            await packs.challengeWeekVolumeFor({
              ...anchor,
              weeksBack,
              customerId: w.customerId,
            })
          ).volumeMyr;
    winners.push({
      rank: w.rank,
      name: profile.name,
      handle: profile.handle,
      pulledMyr: pulled,
      credits: round2(w.credits),
      cards,
      prizeMyr: prizeValue(w.credits, cards),
    });
  }

  return {
    weekStart,
    weekEnd,
    timezone: settings.timezone,
    poolMyr: grouped[0]?.poolMyr ?? null,
    unlockedStages: grouped[0]?.unlockedStages ?? [],
    winners,
    hidden: grouped.length - shown.length,
  };
}
