import { z } from './zod';
import { finite, rarity } from './shared';

/** GET /store/cards/:handle history point — MYR-converted by the backend. */
const CardPricePointSchema = z.looseObject({
  date: z.string(),
  valueMyr: finite,
});

/** GET /store/cards/:handle — single-card display payload. rarity/pcSyncedAt/
 *  priceHistory degrade gracefully (`catch`) instead of nulling the whole card:
 *  a bad optional section must not take down the detail view. */
export const CardDetailSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  set: z.string(),
  grader: z.string(),
  grade: z.string(),
  image: z.string(),
  slab_image: z.string().nullable().catch(null),
  /** The card's configured pixel-Pokémon; absent on an older backend, which
   *  degrades the badge to name-derivation rather than breaking the payload. */
  pokemon_dex: z.number().int().positive().nullable().catch(null).optional(),
  sprite_image: z.string().nullable().catch(null).optional(),
  marketPriceMyr: finite,
  rarity: rarity.nullable().catch(null),
  pcSyncedAt: z.string().nullable().catch(null),
  priceHistory: z.array(CardPricePointSchema).catch([]),
});

/** GET /store/cards/:handle — the `{ card }` wrapper the route answers with.
 *  The card itself is REQUIRED: a 200 without a parseable one is a
 *  backend/contract fault, and data/cards.ts must say 'error' for it rather
 *  than fabricate a 404. */
export const CardDetailEnvelopeSchema = z.looseObject({
  card: CardDetailSchema,
});

/** One settled weekly line as the store surfaces render it (both the
 *  Referral and VIP tabs of /task). Cents + basis points on the wire; the
 *  UI converts for display. */
export const SettlementHistoryRowSchema = z.looseObject({
  week_start: z.string(),
  basis_cents: finite,
  rate_bp: finite,
  amount_cents: finite,
  status: z.string(),
});

/** GET /store/referral — the /referral page payload. */
export const ReferralSummarySchema = z.looseObject({
  handle: z.string(),
  /** The 8-character public referral code — what /r/<code>, the QR and the
   *  signup form's field all carry. Optional (deploy-skew rule): a backend
   *  that predates codes must still render the stats, not blank the page. */
  code: z.string().optional(),
  downline_count: finite,
  week: z.looseObject({
    start: z.string(),
    turnover_cents: finite,
    rate_bp: finite,
    projected_cents: finite,
    partner: z.boolean(),
  }),
  history: z.array(SettlementHistoryRowSchema),
  /** The player's own invited friends, newest first: public name + handle
   *  and what each earned the player this week (cents, rounded down per
   *  row), capped server-side (downline_count stays the full total).
   *  Optional and caught (deploy-skew rule): an older backend or a malformed
   *  list hides the list instead of blanking the page, and never tells a
   *  player with referrals that they have none. */
  friends: z
    .array(
      z.looseObject({
        name: z.string(),
        handle: z.string().nullable(),
        joined_at: z.string(),
        week_earned_cents: finite,
      }),
    )
    .optional()
    .catch(undefined),
});
export type ReferralSummary = z.infer<typeof ReferralSummarySchema>;
export type ReferralFriend = NonNullable<ReferralSummary['friends']>[number];

/** GET /store/referral/codes/:code — public owner-of-code check (display
 *  fields only; the backend never puts PII here). */
export const ReferralCodeLookupSchema = z.looseObject({
  code: z.string(),
  handle: z.string().nullable(),
  name: z.string(),
});
export type ReferralCodeLookup = z.infer<typeof ReferralCodeLookupSchema>;

/** One task row of GET /store/tasks (Phase B). requirement/reward are the
 *  backend's discriminated unions; the tab renders from progress + reward, so
 *  both stay loose JSON here (deploy-skew rule: an unknown new requirement
 *  type must not crash the page). */
export const TaskEntrySchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['daily', 'weekly', 'achievement']),
  title: z.string(),
  requirement: z.looseObject({
    type: z.string(),
    // What a narrowed goal names, so the row can SHOW it ("RIP [Bronze Pack]
    // ×10"): a rip goal's pack, a pull goal's Pokémon. Same optional+nullable
    // skew rule as the reward: absent/null falls back to the goal's icon.
    pack_title: z.string().nullable().optional(),
    pack_image: z.string().nullable().optional(),
    pokemon_name: z.string().nullable().optional(),
    pokemon_image: z.string().nullable().optional(),
  }),
  reward: z.looseObject({
    type: z.string(),
    pack_id: z.string().optional(),
    // A pack reward names its pack. Optional AND nullable: a backend that
    // predates the field omits it, a deleted pack nulls it — both fall back
    // to the bare "Free rip" label.
    pack_title: z.string().nullable().optional(),
    // What each reward is worth, so every row reads "what · RM value". Same
    // optional+nullable skew rule: absent/null just drops the RM figure.
    pack_price_myr: finite.nullable().optional(),
    card_name: z.string().nullable().optional(),
    card_grade: z.string().nullable().optional(),
    card_value_myr: finite.nullable().optional(),
    // The prize's picture, as stored (often storefront-relative). Same skew
    // rule: absent/null falls back to the reward-type art.
    pack_image: z.string().nullable().optional(),
    card_image: z.string().nullable().optional(),
    // A tickets reward's count. Same skew rule: absent reads as the bare name.
    tickets: finite.optional(),
  }),
  progress: z.looseObject({
    current: finite,
    target: finite,
    completed: z.boolean(),
  }),
  claimed: z.boolean(),
  // Lucky Draw tickets this task also pays. A backend that predates the
  // column omits it; an unreadable value reads as none — never a dropped row.
  tickets: finite.catch(0),
});
export type TaskEntry = z.infer<typeof TaskEntrySchema>;

/** GET /store/tasks — the /task Tasks tab payload. */
/** One unspent free-rip entitlement (GET /store/tasks `pending_spins`). */
export const PendingSpinSchema = z.looseObject({
  claim_id: z.string(),
  task_id: z.string(),
  title: z.string(),
  pack_id: z.string(),
  pack_title: z.string().nullable().optional(),
  pack_image: z.string().nullable().optional(),
});

export const TaskHubSchema = z.looseObject({
  week_start: z.string(),
  // Today's MYT date (a daily task's period) and this week's check-in count
  // (the strip's filled slots). Optional: a backend that predates them still
  // renders, the strip falling back to what the tasks themselves say.
  day_key: z.string().optional(),
  checkins_this_week: finite.optional(),
  vip_level: finite,
  checked_in_today: z.boolean(),
  // `.catch([])` is the deploy-skew guard: a backend that predates the field
  // must not drop the whole hub payload and blank the page.
  pending_spins: z.array(PendingSpinSchema).catch([]),
  // Parsed row by row, so ONE task this build cannot read (a cadence added
  // to the backend first) is dropped alone instead of failing the array —
  // and with it the whole hub, which would blank /task.
  tasks: z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row) => {
      const r = TaskEntrySchema.safeParse(row);
      return r.success ? [r.data] : [];
    }),
  ),
});
export type TaskHub = z.infer<typeof TaskHubSchema>;
