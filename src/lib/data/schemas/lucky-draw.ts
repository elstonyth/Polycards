import { z } from './zod';
import { avatarForSeed } from '@/lib/avatar-seed';
import { LUCKY_DRAW_TIERS } from '@/lib/lucky-draw';
import { droppableArray, finite } from './shared';

// The Lucky Draw store routes (backend api/store/lucky-draw/view.ts is the
// source of truth). Deploy-skew rule, as TaskHubSchema: every array is parsed
// row by row, so one prize or row this build cannot read drops alone instead
// of blanking the page; `looseObject` keeps unread fields (a drawn prize's
// `seed` rides on its result, never read off the prize itself).

/** A person (no id: "me" cannot be picked out of a list), mapped to what
 *  FramedAvatar renders with the leaderboard's seed → pfp mapping. A disabled
 *  account arrives as "Anonymous" from the backend. */
const LuckyDrawPersonSchema = z
  .looseObject({
    who: z.string().catch('Anonymous'),
    face_seed: finite.nullable().catch(null),
    avatar_url: z.string().nullable().catch(null),
    frame_url: z.string().nullable().catch(null),
  })
  .transform((p) => ({
    who: p.who,
    avatar:
      p.avatar_url ?? (p.face_seed != null ? avatarForSeed(p.face_seed) : null),
    frame: p.frame_url,
  }));
export type LuckyDrawPerson = z.infer<typeof LuckyDrawPersonSchema>;

const LuckyDrawEntrySchema = z.looseObject({
  person: LuckyDrawPersonSchema,
  tickets: finite,
});
export type LuckyDrawEntry = z.infer<typeof LuckyDrawEntrySchema>;

/** How a prize's picture wears the Lucky Draw frame. Caught: a backend still
 *  deploying sends none, and the picture then shows as it always did. */
const LuckyDrawArtFrameSchema = z
  .enum(['slab', 'raw'])
  .nullable()
  .optional()
  .catch(null);
export type LuckyDrawArtFrame = z.infer<typeof LuckyDrawArtFrameSchema>;

/** A drawn prize. `seed` exists only here, after the draw. */
const LuckyDrawResultSchema = z.looseObject({
  prize_id: z.string(),
  title: z.string(),
  image: z.string().nullable().catch(null),
  frame: LuckyDrawArtFrameSchema,
  value_myr: finite,
  drawn_at: z.string(),
  winner: LuckyDrawPersonSchema.nullable(),
  winner_tickets: finite,
  total_tickets: finite,
  entrant_count: finite,
  seed: z.string(),
  seed_hash: z.string(),
  // One-winner rows of the results feed. Caught: a row never drops over them.
  event_id: z.string().optional().catch(undefined),
  draw_mode: z.string().optional().catch(undefined),
  event_name: z.string().optional().catch(undefined),
  prize_count: finite.optional().catch(undefined),
  tier: z.enum(LUCKY_DRAW_TIERS).nullable().optional().catch(null),
});
export type LuckyDrawResult = z.infer<typeof LuckyDrawResultSchema>;

/** A drawn one-winner event: the proof, once for the whole pot. `seed` exists
 *  only here, after the draw. */
export const LuckyDrawEventResultSchema = z.looseObject({
  winner: LuckyDrawPersonSchema.nullable(),
  winner_tickets: finite,
  total_tickets: finite,
  entrant_count: finite,
  seed: z.string(),
  seed_hash: z.string(),
  drawn_at: z.string(),
});
export type LuckyDrawEventResult = z.infer<typeof LuckyDrawEventResultSchema>;

/** What a one-winner event's winner took: one row per prize. */
const LuckyDrawWonPrizeSchema = z.looseObject({
  kind: z.string().catch('card'),
  title: z.string(),
  image: z.string().nullable().catch(null),
  frame: LuckyDrawArtFrameSchema,
  value_myr: finite,
});

/** One running gate of the page: tickets go on it, and one winner takes its
 *  prizes. A tier this build does not know reads as none: never guess one. */
const LuckyDrawGateSchema = z.looseObject({
  id: z.string(),
  tier: z.enum(LUCKY_DRAW_TIERS).nullable().catch(null),
  starts_at: z.string(),
  ends_at: z.string(),
  // When players could first see it. Caught: "new" then goes by the start.
  live_at: z.string().optional().catch(undefined),
  total_tickets: finite.catch(0),
  entrant_count: finite.catch(0),
  my_tickets: finite.catch(0),
  top: droppableArray(LuckyDrawEntrySchema).catch([]),
  prizes: droppableArray(LuckyDrawWonPrizeSchema).catch([]),
});
export type LuckyDrawGate = z.infer<typeof LuckyDrawGateSchema>;

/** The next published event: the pool coming up, previewed on every state of
 *  the page. Both extras are caught, so an older backend still names it. */
export const NextEventSchema = z.looseObject({
  name: z.string(),
  starts_at: z.string(),
  ends_at: z.string().optional().catch(undefined),
  prizes: droppableArray(LuckyDrawWonPrizeSchema).catch([]),
});

const LuckyDrawPrizeSchema = z
  .looseObject({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    image: z.string().nullable().catch(null),
    frame: LuckyDrawArtFrameSchema,
    value_myr: finite,
    draw_at: z.string(),
    seed_hash: z.string().catch(''),
    total_tickets: finite,
    entrant_count: finite,
    my_tickets: finite.catch(0),
    top: droppableArray(LuckyDrawEntrySchema).catch([]),
    result: LuckyDrawResultSchema.nullable().catch(null),
  })
  // Defence in depth: a prize's seed is never on the page before its result
  // exists; if a backend ever sent one loose, it must not ride on into the
  // client payload.
  .transform((p) => {
    const prize = { ...p };
    delete prize.seed;
    return prize;
  });
export type LuckyDrawPrize = z.infer<typeof LuckyDrawPrizeSchema>;

/** GET /store/lucky-draw-status — public: is a Lucky Draw on? */
export const LuckyDrawStatusSchema = z.looseObject({
  live: z.boolean(),
  // When the newest running gate went live: the Draw tab's dot. Absent on a
  // backend still deploying, which reads as no dot.
  latest_gate_at: z.string().nullable().optional().catch(null),
  // The gates still to draw: what the popup watches. Absent on a backend still
  // deploying, which reads as nothing to watch, so no popup.
  upcoming: droppableArray(
    z.looseObject({ id: z.string(), ends_at: z.string() }),
  )
    .optional()
    .catch(undefined),
});

/** GET /api/lucky-draw-status — the same read, as the site chrome takes it. */
export const LuckyDrawChromeStatusSchema = z.looseObject({
  latest_gate_at: z.string().nullable().catch(null),
  upcoming: droppableArray(
    z.looseObject({ id: z.string(), ends_at: z.string() }),
  ).catch([]),
});

/** GET /store/lucky-draw — the live event (null: none running). */
export const LuckyDrawPageSchema = z.looseObject({
  balance: finite,
  // Every running gate. Absent on a backend still deploying (pageGates falls
  // back to `event`, which stays for a storefront still deploying).
  events: droppableArray(LuckyDrawGateSchema).optional().catch(undefined),
  // One nested object, not a row that can drop alone: every one-winner field
  // is caught, so a card-era payload or one drifted field never blanks the
  // page. A mode this build does not know reads as the old page.
  event: z
    .looseObject({
      id: z.string(),
      name: z.string(),
      starts_at: z.string(),
      ends_at: z.string(),
      draw_mode: z.enum(['per_prize', 'one_winner']).catch('per_prize'),
      seed_hash: z.string().nullable().catch(null),
      total_tickets: finite.catch(0),
      entrant_count: finite.catch(0),
      my_tickets: finite.catch(0),
      top: droppableArray(LuckyDrawEntrySchema).catch([]),
      result: LuckyDrawEventResultSchema.nullable().catch(null),
    })
    // Defence in depth, as the prize: nothing secret rides on into the client
    // payload (the revealed seed lives on `result`).
    .transform((e) => {
      const event = { ...e };
      delete event.seed;
      delete event.seed_nonce;
      return event;
    })
    .nullable(),
  prizes: droppableArray(LuckyDrawPrizeSchema),
  next_event: NextEventSchema.nullable().catch(null),
});
export type LuckyDrawPage = z.infer<typeof LuckyDrawPageSchema>;

/** GET /store/lucky-draw/results — newest draw first, cursor `next_before`. */
export const LuckyDrawResultsSchema = z.looseObject({
  results: droppableArray(LuckyDrawResultSchema),
  next_before: z.string().nullable().catch(null),
});
export type LuckyDrawResults = z.infer<typeof LuckyDrawResultsSchema>;

/** GET /store/lucky-draw/results/:prizeId — the frozen entry list in DRAW
 *  order (never re-sorted: the fair-draw check counts through it) and the
 *  winning ticket. `ticket_index` is not caught: a drifted one must not read
 *  as "No entries". */
export const LuckyDrawResultDetailSchema = z.looseObject({
  result: LuckyDrawResultSchema,
  entries: droppableArray(LuckyDrawEntrySchema),
  ticket_index: finite.nullable(),
  /** The viewer's row in `entries`; absent or null with none (the arena then has
   *  no discs to pick out). */
  my_entry_index: finite.nullable().optional().catch(null),
  /** One-winner only (eventResultDetail): everything the winner took. */
  prizes: droppableArray(LuckyDrawWonPrizeSchema).optional().catch(undefined),
});
export type LuckyDrawResultDetail = z.infer<typeof LuckyDrawResultDetailSchema>;

/** GET /store/lucky-draw/results/events/:eventId — one drawn event: its result,
 *  every prize, and the frozen entry list in DRAW order. `ticket_index` is not
 *  caught, for the same reason as above. */
export const LuckyDrawEventDetailSchema = z.looseObject({
  result: LuckyDrawEventResultSchema,
  prizes: droppableArray(LuckyDrawWonPrizeSchema).catch([]),
  entries: droppableArray(LuckyDrawEntrySchema),
  ticket_index: finite.nullable(),
  my_entry_index: finite.nullable().optional().catch(null),
  tier: z.enum(LUCKY_DRAW_TIERS).nullable().optional().catch(null),
});
export type LuckyDrawEventDetail = z.infer<typeof LuckyDrawEventDetailSchema>;

/** GET /store/lucky-draw/me — balance, ticket history, my entries. */
export const LuckyDrawMineSchema = z.looseObject({
  balance: finite,
  history: droppableArray(
    z.looseObject({
      delta: finite,
      reason: z.string(),
      created_at: z.string(),
    }),
  ).catch([]),
  entries: droppableArray(
    z.looseObject({
      prize_id: z.string(),
      title: z.string(),
      image: z.string().nullable().catch(null),
      frame: LuckyDrawArtFrameSchema,
      my_tickets: finite,
      draw_at: z.string(),
      status: z.string(),
      // Set on a one-winner row, where prize_id is the event id.
      event_id: z.string().optional().catch(undefined),
      tier: z.enum(LUCKY_DRAW_TIERS).nullable().optional().catch(null),
      // One-winner rows only: every ticket in the pool.
      total_tickets: finite.optional().catch(undefined),
    }),
  ).catch([]),
});
export type LuckyDrawMine = z.infer<typeof LuckyDrawMineSchema>;

/** GET /store/lucky-draw/balance — the vault's tickets row. */
export const LuckyDrawBalanceSchema = z.looseObject({ balance: finite });

/** POST /store/lucky-draw/prizes/:id/enter. The accepted branch is lenient on
 *  purpose: the tickets are already spent, so drifted numbers must never read
 *  as a failure the player "tries again" on (and enters twice). Missing
 *  numbers make the page re-read itself instead. */
export const LuckyDrawEnterSchema = z.discriminatedUnion('entered', [
  z.looseObject({
    entered: z.literal(true),
    balance: finite.optional().catch(undefined),
    myTickets: finite.optional().catch(undefined),
  }),
  z.looseObject({
    entered: z.literal(false),
    reason: z.string().catch(''),
  }),
]);
