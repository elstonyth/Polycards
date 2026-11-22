import { z } from '@/lib/data/schemas';
import { num } from '@/lib/format';

const money = z.number().finite().nonnegative();
const percent = z.number().min(0).max(100);
export const COIN_FLIP_MAX_CARDS = 20;
export const COIN_FLIP_MAX_TICKETS = 10_000;
export const COIN_FLIP_QUOTE_MS = 60_000;
export const coinFlipTicketsLabel = (tickets: number) =>
  `${num(tickets)} ${tickets === 1 ? 'ticket' : 'tickets'}`;
export const coinFlipTicketsGone = (tickets: number) =>
  tickets === 1
    ? 'The ticket you flipped is gone.'
    : `All ${num(tickets)} tickets you flipped are gone.`;
export const CoinSideSchema = z.enum(['head', 'tail']);
export type CoinSide = z.infer<typeof CoinSideSchema>;
export const coinSideLabel = (side: CoinSide) =>
  side === 'head' ? 'Head' : 'Tail';
const card = z.object({
  pull_id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  grader: z.string().nullable(),
  grade: z.string().nullable(),
});
export const CoinFlipRoundSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['quoted', 'won', 'lost']),
    expires_at: z.iso.datetime(),
    settled_at: z.iso.datetime().nullable(),
    stake_amount: money,
    win_amount: money,
    published_win_percent: percent,
    card: card.nullable(),
    cards: z
      .array(card.extend({ stake_amount: money.positive() }))
      .max(COIN_FLIP_MAX_CARDS),
    // Lucky Draw tickets staked; 0 when none. They never pay or cost money.
    tickets: z.number().int().min(0).max(COIN_FLIP_MAX_TICKETS).default(0),
    chosen_side: CoinSideSchema,
    landed_side: CoinSideSchema.nullable(),
  })
  .refine(
    (round) =>
      (round.cards.length > 0
        ? round.card !== null &&
          round.stake_amount > 0 &&
          new Set(round.cards.map((card) => card.pull_id)).size ===
            round.cards.length &&
          round.cards.reduce(
            (sum, card) => sum + Math.round(card.stake_amount * 100),
            0,
          ) === Math.round(round.stake_amount * 100)
        : round.tickets > 0 &&
          round.card === null &&
          round.stake_amount === 0 &&
          round.win_amount === 0) &&
      // A receipt that disagrees with itself is not shown as money.
      Math.round(round.win_amount * 100) ===
        (round.status === 'won' ? Math.round(round.stake_amount * 100) : 0) &&
      (round.settled_at === null) === (round.status === 'quoted') &&
      (round.status === 'quoted'
        ? round.landed_side === null
        : round.landed_side ===
          (round.status === 'won'
            ? round.chosen_side
            : round.chosen_side === 'head'
              ? 'tail'
              : 'head')),
    'Inconsistent coin flip receipt',
  );
export const CoinFlipReceiptSchema = z.object({ round: CoinFlipRoundSchema });
export const CoinFlipHistorySchema = z.object({
  rounds: z.array(CoinFlipRoundSchema),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  // How every flip the customer made landed, whatever the rows are filtered by.
  totals: z.object({
    head: z.number().int().nonnegative(),
    tail: z.number().int().nonnegative(),
  }),
});
// Every player's latest settled flips (the page's Everyone view), each with
// the player's public display fields, as the Just Pulled feed shows them.
const CoinFlipFeedRoundSchema = CoinFlipRoundSchema.and(
  z.object({
    who: z.string(),
    seed: z.number().nullable(),
    avatar_url: z.string().nullable(),
    frame_url: z.string().nullable(),
  }),
);
// Everyone reads this list, so one malformed row is dropped, not the feed.
export const CoinFlipFeedSchema = z.object({
  rounds: z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row) => {
      const parsed = CoinFlipFeedRoundSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});
export const CoinFlipSettingsSchema = z.object({
  enabled: z.boolean(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  // Optional: the backend deploys apart, and one from before the code sends none.
  reason_code: z.string().nullish(),
  published_win_percent: percent.nullable(),
});
/** Coin Flip's words for a player who must top up first: RM 50 in total,
 *  spent or not (owner, 2026-11-21). */
export const COIN_FLIP_NO_TOPUP =
  'Top up at least RM 50 in total to play Coin Flip.';
/** Why this account cannot flip: Coin Flip copy for a code it knows, else the server's text. */
export const coinFlipRefusal = (s: CoinFlipSettings): string | null =>
  s.reason_code === 'no_topup' ? COIN_FLIP_NO_TOPUP : s.reason;
export type CoinFlipRound = z.infer<typeof CoinFlipRoundSchema>;
export type CoinFlipSettings = z.infer<typeof CoinFlipSettingsSchema>;
export type CoinFlipHistory = z.infer<typeof CoinFlipHistorySchema>;
export type CoinFlipFeedRound = z.infer<typeof CoinFlipFeedRoundSchema>;
export type CoinFlipFailure = {
  ok: false;
  error: string;
  uncertain: boolean;
  missing?: boolean;
};
export const quoteIsLive = (round: CoinFlipRound, now: number) =>
  round.status === 'quoted' && Date.parse(round.expires_at) > now;
export const coinFlipPendingKey = (customerId: string) =>
  `polycards:coin-flip:${customerId}`;

/* ------------------------------------------------------------------ *
 * Page phase — the one machine behind CoinFlipClient, tested in
 * src/lib/__tests__/coin-flip-phase.test.ts (the same shape as
 * reveal-phase.ts's nextPhase).
 * ------------------------------------------------------------------ */

export type CoinFlipPhase =
  | 'loading'
  | 'idle'
  | 'quoting'
  | 'confirm'
  | 'armed'
  | 'submitting'
  | 'recovering'
  | 'animating'
  | 'result';

export type CoinFlipEvent =
  /** The page mounted with no flip to resume. */
  | 'ready'
  /** A flip is opened by id: the mount's resume, a history row, Check result. */
  | 'open'
  /** Review pressed: ask for a quote. */
  | 'review'
  /** The quote arrived. */
  | 'quoted'
  /** The quote or the accept was refused, or the quote never arrived: nothing
   *  is staked, so the stake is picked again. */
  | 'refused'
  /** The opened flip no longer exists. */
  | 'missing'
  /** Confirm pressed on the quote: the coin is armed. */
  | 'arm'
  /** Cancel, the backdrop, Escape or Review again: back to picking. */
  | 'cancel'
  /** Flip coin pressed or the coin flicked. */
  | 'toss'
  /** Retry same flip, for a flip whose result is unknown. */
  | 'retry'
  /** A settled receipt shown without the toss (a reopened or retried flip). */
  | 'settled'
  /** A settled receipt from a toss made here: the coin flies first. */
  | 'tossed'
  /** The coin's flight ended, or Skip. */
  | 'landed'
  /** The result is not confirmed: only Check result or Retry may follow. */
  | 'uncertain'
  /** Flip again, Choose cards or Choose amount from a result. */
  | 'restake';

// Every entry is a setPhase call site in CoinFlipClient, and the from-phases
// are the ones its guards (busy, `locked`, the paused history) let through, so
// an unlisted pair is one no reachable code path produces. coinFlipNext holds
// the phase for those rather than throwing: a late event must never strand a
// staked flip without its receipt.
//
// Two rows look surprising and are not:
//   confirm --open--> loading   the confirm sheet covers the history, but the
//                               page set 'loading' unconditionally before this
//                               table, so the row stays in case focus escapes.
//   armed --open--> loading     the history stays live while armed; opening a
//                               row drops the armed quote, as it always did.
// submitting and animating accept only their own outcomes: a toss in the air
// cannot be interrupted (busy, and the history pauses).
const COIN_FLIP_TRANSITIONS: Record<
  CoinFlipPhase,
  Partial<Record<CoinFlipEvent, CoinFlipPhase>>
> = {
  loading: {
    ready: 'idle',
    open: 'loading',
    settled: 'result',
    uncertain: 'recovering',
    missing: 'idle',
  },
  idle: { review: 'quoting', open: 'loading' },
  quoting: { quoted: 'confirm', refused: 'idle' },
  confirm: { arm: 'armed', cancel: 'idle', open: 'loading' },
  armed: { toss: 'submitting', cancel: 'idle', open: 'loading' },
  submitting: {
    tossed: 'animating',
    settled: 'result',
    refused: 'idle',
    uncertain: 'recovering',
  },
  recovering: { retry: 'submitting', open: 'loading' },
  animating: { landed: 'result' },
  result: { restake: 'idle', open: 'loading' },
};

/** The phase `event` leads to from `from`, or `from` unchanged when the pair is
 *  not a legal transition. Apply it through a functional state update
 *  (`setPhase((p) => coinFlipNext(p, 'quoted'))`). */
export function coinFlipNext(
  from: CoinFlipPhase,
  event: CoinFlipEvent,
): CoinFlipPhase {
  return COIN_FLIP_TRANSITIONS[from][event] ?? from;
}
