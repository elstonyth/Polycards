// The Lucky Draw "New event" prize pool's pure half: which inventory rows can
// be picked, what the pool adds up to, and the one request that creates the
// event with its prizes. Split out of the form for the reason
// lucky-draw-draft.ts is — the admin vitest runner has no DOM.
import type {
  AdminLuckyDrawEventInput,
  AdminLuckyDrawNewPrize,
  InventoryRow,
} from '../../lib/admin-rest';
import {
  MAX_PRIZE_TITLE,
  blankPrizeDraft,
  eventDraftToPayload,
  parseCreditAmount,
  prizeDraftToPayload,
  type EventDraft,
  type PrizeDraft,
} from './lucky-draw-draft';

/** The most prizes one create request carries (the backend refuses more). */
export const MAX_NEW_EVENT_PRIZES = 100;

/** A picked card. A snapshot of the inventory row, not a handle looked up
 *  later: a new search replaces the rows on screen and the pick must survive. */
export interface PoolCard {
  handle: string;
  name: string;
  photo: string | null;
  /** RM — the inventory row's `price`. null = no FMV recorded. */
  value: number | null;
  /** The prize title the players see; starts as the card name. */
  title: string;
}

/** A credit prize being added. Strings, like the other drafts: the inputs
 *  hold what was typed. */
export interface PoolCredit {
  key: string;
  amount: string;
  /** Blank = the default, `creditTitle(amount)`. */
  title: string;
  imageUrl: string;
}

let nextKey = 0;
export const blankCredit = (): PoolCredit => ({
  key: `credit-${++nextKey}`,
  amount: '',
  title: '',
  imageUrl: '',
});

/** Every registered card, whatever its stock. A card prize is minted to the
 *  winner at the draw like a challenge's card prize, so the operator picks any
 *  card (spec 2026-10-24). Never gate on stock: the Medusa counter is 0 or
 *  below for nearly every card (1 of 1,200 above 0 on 2026-10-30). */
export const prizeCards = (rows: InventoryRow[]): InventoryRow[] =>
  rows.filter((r) => r.is_card);

export const poolCardFrom = (r: InventoryRow): PoolCard => ({
  handle: r.handle,
  name: r.name,
  photo: r.photo,
  value: r.price,
  title: r.name,
});

export const creditAmount = (c: PoolCredit): number | null =>
  parseCreditAmount(c.amount);

/** Change one credit row of the LATEST list, found by key. A late result (an
 *  image upload that lands after the row was edited or removed) goes through
 *  this inside a state updater, so it can neither roll back what was typed
 *  meanwhile nor bring a removed row back. */
export const patchCredit = (
  list: PoolCredit[],
  key: string,
  patch: Partial<Omit<PoolCredit, 'key'>>,
): PoolCredit[] => list.map((c) => (c.key === key ? { ...c, ...patch } : c));

/** "RM 98,400" — whole amounts without decimals, anything else with two. */
export const poolMoney = (n: number): string => {
  const sen = Math.round(n * 100);
  return `RM ${(sen / 100).toLocaleString('en-MY', {
    minimumFractionDigits: sen % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

export const creditTitle = (amount: number): string =>
  `${poolMoney(amount)} bonus credit`;

/** Card values plus the credit amounts that parse, in whole sen. */
export const poolTotal = (cards: PoolCard[], credits: PoolCredit[]): number => {
  const sen = (n: number) => Math.round(n * 100);
  return (
    (cards.reduce((t, c) => t + sen(c.value ?? 0), 0) +
      credits.reduce((t, c) => t + sen(creditAmount(c) ?? 0), 0)) /
    100
  );
};

export const poolSummary = (
  cards: PoolCard[],
  credits: PoolCredit[],
): string => {
  const n = cards.length + credits.length;
  if (n === 0) return 'No prizes yet';
  const noValue = cards.filter((c) => c.value === null).length;
  return [
    `${n} prize${n === 1 ? '' : 's'}`,
    poolMoney(poolTotal(cards, credits)),
    // A card with no FMV adds nothing, so say the total is short.
    ...(noValue > 0
      ? [`${noValue} card${noValue === 1 ? ' has' : 's have'} no value yet`]
      : []),
  ].join(' · ');
};

const toNewPrize = (p: {
  kind: 'card' | 'credit';
  card_handle: string | null;
  credit_myr: number | null;
  title: string;
  image_url: string | null;
  sort: number;
  draw_at: string | null;
}): AdminLuckyDrawNewPrize => ({
  kind: p.kind,
  card_handle: p.card_handle,
  credit_myr: p.credit_myr,
  title: p.title,
  image_url: p.image_url,
  sort: p.sort,
  draw_at: p.draw_at,
});

/** The create request: the event plus its prizes, cards first then credits,
 *  `sort` in that order, every draw time left to the backend (the event's
 *  end). null when the backend would refuse any of it — each prize goes
 *  through the same check the prize editor uses. */
export function newEventPayload(
  draft: EventDraft,
  cards: PoolCard[],
  credits: PoolCredit[],
): AdminLuckyDrawEventInput | null {
  // An id makes it an edit, and an edit takes no prizes.
  if (draft.id) return null;
  const event = eventDraftToPayload(draft);
  if (!event || cards.length + credits.length > MAX_NEW_EVENT_PRIZES) {
    return null;
  }

  const drafts: PrizeDraft[] = [
    ...cards.map(
      (c): PrizeDraft => ({
        ...blankPrizeDraft(),
        kind: 'card',
        cardHandle: c.handle,
        title: (c.title.trim() || c.name.trim()).slice(0, MAX_PRIZE_TITLE),
      }),
    ),
    ...credits.map((c): PrizeDraft => {
      const amount = creditAmount(c);
      return {
        ...blankPrizeDraft(),
        kind: 'credit',
        creditMyr: c.amount,
        imageUrl: c.imageUrl,
        title: c.title.trim() || (amount === null ? '' : creditTitle(amount)),
      };
    }),
  ];

  const prizes: AdminLuckyDrawNewPrize[] = [];
  for (const [i, d] of drafts.entries()) {
    const payload = prizeDraftToPayload({ ...d, sort: String(i) }, '');
    if (payload === null) return null;
    prizes.push(toNewPrize(payload));
  }
  return { ...event, prizes };
}
