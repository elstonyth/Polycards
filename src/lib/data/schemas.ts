/**
 * Runtime schemas for the custom-backend (`sdk.client.fetch`) responses.
 *
 * The SDK's `fetch<T>` generic is a TYPE ASSERTION, not a runtime guard — a
 * renamed/absent field would otherwise render "$NaN" or an undefined rarity
 * ring. These zod schemas are the guard, centralizing the per-getter validation
 * that used to be hand-rolled `.filter()` predicates.
 *
 * IMPORTANT — behaviour-preserving: each schema validates EXACTLY the fields its
 * getter checked before (no stricter), using `looseObject` so unchecked-but-read
 * fields pass through untouched. `parseList` DROPS invalid items (mirroring the
 * old `.filter()` — one bad row never throws the whole list); `parseOne` returns
 * null on failure (mirroring the single-object validate-or-null getters). zod's
 * default `.parse()` would THROW — these helpers deliberately do not.
 */
import { z } from 'zod';
import { isRarity } from '@/lib/packs-format';

// Zod 4's JIT compiles schemas with `new Function(...)`; our CSP `script-src`
// has no 'unsafe-eval' (see src/lib/security/csp.ts), so that probe fires a CSP
// violation on every load. `jitless` forces the interpreted parser instead.
// Set here because this module is the app's sole `zod` importer.
z.config({ jitless: true });

/** Matches the getters' `Number.isFinite(x)` checks exactly (rejects NaN/±∞). */
const finite = z.number().refine((n) => Number.isFinite(n));
/** A string that is one of the known gacha rarities (the old `isRarity` guard). */
const rarity = z.string().refine(isRarity);

/** Drop invalid items — mirrors `(Array.isArray(x)?x:[]).filter(predicate)`. */
export function parseList<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}

/** Null on failure — mirrors a single-object `if (!valid) return null`. */
export function parseOne<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

/** An array field that DROPS invalid items instead of failing the whole parse —
 *  the nested-object analog of `parseList` (one bad row never blanks the
 *  survivors). Use inside a `parseOne` object so a single malformed row degrades
 *  the row, not the whole response.
 *  ponytail: assumes items are never legitimately `null` (true for every object
 *  item here); a schema that allows null would lose those genuine nulls too. */
function droppableArray<T>(item: z.ZodType<T>) {
  return z
    .array(item.nullable().catch(null))
    .transform((arr) => arr.filter((v): v is T => v !== null));
}

/** Record equivalent of `droppableArray` — drops invalid VALUES, keeps the rest. */
function droppableRecord<T>(item: z.ZodType<T>) {
  return z
    .record(z.string(), item.nullable().catch(null))
    .transform(
      (rec) =>
        Object.fromEntries(
          Object.entries(rec).filter(([, v]) => v !== null),
        ) as Record<string, T>,
    );
}

// --- data/packs.ts ----------------------------------------------------------

/** GET /store/packs row — getter checks `category` + finite `price` only. */
export const PackRowSchema = z.looseObject({
  category: z.string(),
  price: finite,
  /** §2.4.8 pool composition, backend-derived (GRADED = every card graded,
   *  RAW = none, MIX = both, null = empty pool). Absent on an older backend;
   *  a malformed value degrades to null rather than dropping the pack row. */
  group: z.enum(['GRADED', 'RAW', 'MIX']).nullable().catch(null).optional(),
  /** Strict guarantee gate: true iff EVERY pooled card is a PSA 10 (stricter
   *  than group === 'GRADED' — a PSA 9 or a BGS slab is graded but not psa10).
   *  Malformed/absent degrades to false: never overclaim the guarantee. */
  psa10: z.boolean().catch(false).optional(),
});

/** GET /store/packs/:slug odds row — handle + known rarity + finite value.
 *  marketPriceMyr (live MYR display price: FMV × FX × margin, computed by the
 *  backend at request time) is optional — an older backend without it falls
 *  back to the raw USD market_value. */
export const OddsEntrySchema = z.looseObject({
  handle: z.string(),
  rarity,
  market_value: finite,
  marketPriceMyr: finite.optional(),
  /** Admin-picked Top Hit display order (1-based; null/absent = not one).
   *  Malformed values degrade to null instead of dropping the whole row. */
  top_hit_order: z.number().int().positive().nullable().catch(null).optional(),
  /** The card's configured pixel-Pokémon (mirror of its linked library entry);
   *  a malformed value degrades to null so the reel falls back to name-derive. */
  pokemon_dex: z.number().int().positive().nullable().catch(null).optional(),
  sprite_image: z.string().nullable().catch(null).optional(),
});

/** GET /store/pulls/recent row — handle + name + known rarity + finite value.
 *  marketPriceMyr optional, same contract as the odds row above. */
export const RecentPullSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
  marketPriceMyr: finite.optional(),
});

// --- data/leaderboard.ts ----------------------------------------------------

/** GET /store/leaderboard row — name + finite points/volume/pulls. */
export const LeaderboardEntrySchema = z.looseObject({
  name: z.string(),
  points: finite,
  volume: finite,
  pulls: finite,
  avatar_url: z.string().nullable().optional(),
  equipped_frame_level: finite.nullable().optional(),
});

// --- data/challenge.ts ------------------------------------------------------

/** GET /store/challenge — the Weekly Challenge structure. This seam is
 *  display-only (pool / standings / summary — no sell path), so it FAILS OPEN:
 *  only `active` + `settings` are hard-required; every other section degrades
 *  gracefully so a single malformed row/section can't blank the challenge block.
 *  A malformed `stage`/`top` row is DROPPED (survivors kept, mirroring
 *  `parseList`); a malformed `cards` entry is dropped; a malformed `progress`
 *  degrades to absent (pool/summary hide). Only `active:false`, an empty stage
 *  list, or a broken `active`/`settings` makes the seam return null → the
 *  page's "launching soon" empty state. `cards` maps card ids to a thumbnail. */
export const ChallengeSchema = z.looseObject({
  active: z.boolean(),
  /** Real community pulled-value this week (ledger aggregate). Optional for
   *  deploy skew — an older backend without it renders the page without the
   *  pool panel. `.catch(undefined)` so a MALFORMED progress also degrades to
   *  absent instead of dropping the whole challenge. */
  progress: z.looseObject({ pooledMyr: finite }).optional().catch(undefined),
  settings: z.looseObject({
    timezone: z.string(),
    resetDay: finite,
    resetHour: finite,
  }),
  /** A malformed stage is dropped, not fatal — surviving stages still render.
   *  `rankRewards` is the per-rank prize table (plan 057): SPARSE — an absent
   *  rank pays nothing, and a rank may carry a card AND/OR credits. A malformed
   *  RANK ROW drops that row only (droppableArray), a non-array table degrades
   *  to `[]`, and the whole field is optional for deploy skew (an older backend
   *  without it renders the stage with no prize tiles rather than vanishing). */
  stages: droppableArray(
    z.looseObject({
      stageNumber: finite,
      thresholdMyr: finite,
      rankRewards: droppableArray(
        z.looseObject({
          // Strict 1-10 integer: StageCarousel indexes RANKS[rank-1] with a
          // non-null assertion, so a 0 / negative / fractional rank would crash
          // the whole challenge tile. droppableArray drops the bad row instead.
          rank: z.number().int().min(1).max(10),
          cardId: z.string().nullable().catch(null),
          credits: finite,
        }),
      )
        .optional()
        .catch(undefined),
    }),
  ),
  /** A malformed card entry drops that thumbnail (getter tolerates unresolved
   *  ids), not the whole challenge. */
  cards: droppableRecord(
    z.looseObject({
      name: z.string(),
      image: z.string(),
      /** Public route key for /card/<handle>. Optional for deploy skew — an
       *  older backend omits it and the thumbnail renders without a link
       *  rather than pointing at /card/undefined. */
      handle: z.string().nullish(),
      /** The graded-slab composite when the card has one. Optional for deploy
       *  skew — an older backend omits it and the card renders unframed. */
      slab_image: z.string().nullish(),
    }),
  ),
  /** Weekly Pull Value top-10 (pulled-value ranked, PII-safe names). Optional
   *  for deploy skew — absent hides the standings section. Bad rows drop like
   *  the leaderboard's; a non-array `top` degrades to absent via `.catch`. */
  top: droppableArray(
    z.looseObject({
      rank: finite,
      name: z.string(),
      handle: z.string().nullable().optional(),
      volumeMyr: finite,
      pulls: finite,
      seed: finite,
      avatar_url: z.string().nullable().optional(),
    }),
  )
    .optional()
    .catch(undefined),
});

// --- data/profiles.ts -------------------------------------------------------

/** GET /store/profiles/:handle — handle string + a stats object present. */
export const PublicProfileSchema = z.looseObject({
  handle: z.string(),
  stats: z.looseObject({}),
  avatar_url: z.string().nullable().optional(),
  equipped_frame_level: finite.nullable().optional(),
});

// --- data/avatar-frames.ts ---------------------------------------------------

/** GET /store/avatar-frames — public milestone-frame catalog. */
export const AvatarFramesSchema = z.looseObject({
  frames: z.record(z.string(), z.string()),
});

/** GET /store/profiles/me — `{ handle }`. */
export const ProfileHandleSchema = z.looseObject({ handle: z.string() });

// --- actions/vault.ts -------------------------------------------------------

/** GET /store/vault item — pull_id + card.name + finite buyback.amount/percent.
 *  `percent` is required (mirrors OpenBuybackSchema): the sell modal renders it
 *  as the customer commits, so a dropped field must drop the row, not show NaN%. */
export const VaultItemSchema = z.looseObject({
  pull_id: z.string(),
  showcased: z.boolean().optional(),
  card: z.looseObject({ name: z.string() }),
  // How the pull was acquired, and whether it is sell/deliver locked (the free
  // welcome pull before the account's first PAID open). `.catch` rather than
  // required: a cached/older payload must keep parsing, because parseList DROPS
  // a failing row — which would delete the customer's card from their own
  // vault. `locked` defaults FALSE for the same reason (a stuck lock is worse
  // than a late one; the backend refuses the sell either way).
  // ⚠ Lock UI keys off `locked` ONLY, never `source`: a weekly-challenge prize
  // is source='reward' with a live, sellable quote.
  source: z.enum(['pack', 'reward', 'free']).catch('pack'),
  locked: z.boolean().catch(false),
  // Narrower than `locked`: a reward card cannot be SOLD but can be SHIPPED.
  // Defaults TRUE so a backend that predates the field behaves exactly as it
  // did before — the sell then refuses server-side rather than the vault
  // hiding a card the customer owns.
  sellable: z.boolean().catch(true),
  // `firm` is false when the backend priced the quote on its FX display
  // fallback — selling would be refused, so the UI must not offer it as firm.
  // Optional: an older backend omits it (treated as firm).
  buyback: z.looseObject({
    amount: finite,
    percent: finite,
    firm: z.boolean().optional(),
  }),
});

// --- data/free-pack.ts ------------------------------------------------------

/** GET /store/free-pack — the one-time welcome-pack claim badge's whole answer.
 *  `image` rides along on the loose object but is unread: the badge art is a
 *  fixed local asset, not the pack shot. Anything unparsable degrades to "not
 *  eligible" in the getter — the badge is an enhancement, never an error
 *  surface. */
export const FreePackSchema = z.looseObject({
  eligible: z.boolean(),
  slug: z.string().nullable(),
  /** Anonymous answers only: "an active free pack exists" (the signup hook). */
  promo: z.boolean().optional(),
});

/** POST /store/vault/:id/showcase response — pull_id + final showcased state. */
export const VaultShowcaseSchema = z.looseObject({
  pull_id: z.string(),
  showcased: z.boolean(),
});

/** GET /store/credits — finite balance. */
export const BalanceSchema = z.looseObject({ balance: finite });

/** GET /store/vault/latest and GET /store/credits/latest — the newest event on
 *  an unread-dot surface. null when there is nothing; the client renders no dot. */
export const LatestEventSchema = z.looseObject({
  latest_event_at: z.string().nullable(),
});

/** GET /store/credits — lifetime totals (balance is also validated by BalanceSchema).
 *  `has_more` (pagination) is optional so an older backend still parses. */
export const CreditsSchema = z.looseObject({
  balance: finite,
  topup_total: finite,
  spend_total: finite,
  has_more: z.boolean().optional(),
});

/** Every reason the backend `credit_transaction` ledger emits (keep in sync with
 *  backend models/credit-transaction.ts) — the known set that gets a proper
 *  label (`REASON_LABEL` in transactions.ts) and a `CreditReason` type for
 *  call sites that only ever produce a known reason. It is NOT a validation
 *  gate: `CreditTransactionSchema.reason` accepts any string (see below), so a
 *  backend reason added before the storefront redeploys still renders — as a
 *  generic prettified row via `reasonLabel`'s fallback — instead of vanishing
 *  from the customer's history (audit 2026-07-07 #11; parseList silently
 *  dropped rows failing the old `z.enum(CREDIT_REASONS)` check). */
export const CREDIT_REASONS = [
  'buyback',
  'topup',
  'pack_open',
  'adjustment',
  'cashout',
  'voucher_claim',
  'reward_credit',
  'daily_reward',
  // Referral rebuild (spec 2026-08-24): the Wednesday settlement payout.
  'referral_commission',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

/** GET /store/credits transaction row. `amount` is signed (credit +, spend −).
 *  `reason` is any string, not `z.enum(CREDIT_REASONS)` — a backend reason
 *  added before the storefront redeploys must still RENDER (generic label)
 *  — parseList dropping it made history rows silently vanish (audit
 *  2026-07-07 #11; repeat-offender class). */
export const CreditTransactionSchema = z.looseObject({
  id: z.string(),
  amount: finite,
  reason: z.string(),
  created_at: z.string(),
  // Payment-gateway reference (topup/cashout rows; null otherwise). Optional
  // so an older backend that omits the field still parses.
  reference: z.string().nullable().optional(),
});

/** POST /store/credits/topup response — finite amount + balance. `replayed`
 *  is true when the backend deduped an already-processed Idempotency-Key
 *  (nothing new was charged — sim P2-4); optional so an older backend that
 *  omits the flag still parses. */
export const AmountBalanceSchema = z.looseObject({
  amount: finite,
  balance: finite,
  replayed: z.boolean().optional(),
});

/** GET /store/credits/deposit row — a top-up the customer has started at the
 *  gateway that has not settled yet. `amount` is what we REQUESTED: the settled
 *  figure can differ (a customer may pay another sum), and until it settles
 *  nobody knows it, so the UI must say "confirming", never "credited".
 *  `created_at` drives the elapsed-time line, `merchant_transaction_id` is the
 *  reference support asks for. */
export const PendingDepositSchema = z.looseObject({
  merchant_transaction_id: z.string(),
  amount: finite,
  payment_method_code: z.string().optional(),
  created_at: z.string(),
});

/** POST /store/credits/deposit response — the real payment gateway. Unlike the
 *  mock top-up this credits NOTHING yet: it returns the gateway's cashier URL,
 *  and credit only lands when their signed callback settles the deposit. `url`
 *  is the only field the redirect flow needs; the bank/QR extras ride along on
 *  the loose object for a future in-page renderer. */
export const DepositStartSchema = z.looseObject({
  // The cashier URL comes from the GATEWAY's response body, which — unlike
  // their callbacks — carries no signature; TLS is the only thing vouching for
  // it, and it flows straight into window.location.assign. A bare z.string()
  // accepts 'javascript:' and 'data:', which CSP script-src does not block for
  // a navigation. Requires a compromised gateway or TLS interception, so this
  // is a trust-boundary belt, not a live hole.
  url: z
    .string()
    .refine((u) => /^https:\/\//i.test(u), 'cashier url must be https'),
  transactionId: z.string(),
  merchantTransactionId: z.string(),
  amount: finite,
});

/** POST /store/credits/withdraw response. The debit already happened —
 *  `balance` is the post-debit balance, and the payout completes (or refunds)
 *  asynchronously via the gateway callback. `transactionId` is null when the
 *  submit outcome was ambiguous (still resolves asynchronously) OR the row was
 *  held for admin approval instead of submitted (see `status`).
 *  `status: 'held'` means the amount left the balance but a human has not yet
 *  approved sending it to the gateway (plan 094) — the form must not render
 *  that as a completed payout.
 *  `.optional()`, not required: this field shipped in plan 094, and the
 *  storefront and backend are separate deploy units (own DO app components) —
 *  a storefront build that rolls out ahead of the backend must still parse a
 *  response with no `status` at all. Absent means a pre-094 backend, which
 *  has no held state, so defaulting to 'pending' downstream (vault.ts) is the
 *  true reading, not a guess. Same reasoning as `usableFrom` on
 *  SavedBankAccountsSchema below: making this required would fail the WHOLE
 *  object during that skew window, and `parseOne` returning null AFTER the
 *  backend already debited is the exact "money vanished" failure this plan
 *  exists to prevent, reached through a different door. */
export const WithdrawStartSchema = z.looseObject({
  merchantTransactionId: z.string(),
  transactionId: z.string().nullable(),
  amount: finite,
  balance: finite,
  status: z.enum(['pending', 'held']).optional(),
});

/** GET /store/credits/withdraw/banks response — the payout bank picker. */
export const WithdrawBanksSchema = z.looseObject({
  banks: z.array(z.looseObject({ bankCode: z.string(), bankName: z.string() })),
});

/** /store/credits/withdraw/accounts responses (GET/POST/DELETE all return the
 *  full list) — the customer's saved payout accounts.
 *
 *  `usableFrom` is the server's verdict on the cooling-off window and the only
 *  source of it: an ISO instant the account becomes payable, or null when it
 *  never will without being re-saved. The client renders it and never
 *  recomputes the window, so retuning the backend env moves the UI too.
 *  `.nullish()` because a backend that predates the field omits it entirely —
 *  which lands on the same "not usable" rendering as null, the safe direction. */
export const SavedBankAccountsSchema = z.looseObject({
  accounts: z.array(
    z.looseObject({
      id: z.string(),
      bankCode: z.string(),
      bankName: z.string(),
      accountNumber: z.string(),
      accountHolderName: z.string(),
      usableFrom: z.string().nullish(),
    }),
  ),
});

/** POST /store/vault/:id/buyback response — finite amount + balance. `percent`
 *  rides along but is NOT rendered on the sell path (consumers read amount/
 *  balance), so it stays OPTIONAL: requiring it would false-fail an idempotent
 *  buyback that succeeded server-side but omitted the field. The rendered
 *  percent is guarded on the vault-list side (VaultItemSchema). */
export const BuybackResultSchema = z.looseObject({
  amount: finite,
  balance: finite,
  percent: finite.optional(),
});

// --- actions/packs.ts -------------------------------------------------------

/** Open-route `card` — handle + name + known rarity + finite market_value.
 *  marketPriceMyr (live MYR display price) is optional — an older backend
 *  that hasn't been enriched yet simply omits it. */
export const WonCardSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
  pokemon_dex: z.number().nullable().optional(),
  sprite_image: z.string().nullable().optional(),
  marketPriceMyr: finite.optional(),
});

/** Open-route `buyback` offer — instant percent/amount (required) + the vault
 *  rate/amount and instant deadline (optional; older backends omit them).
 *  `firm:false` = quoted on the FX display fallback; selling would be refused
 *  ("Exchange rate unavailable"), so the reveal must not present it as firm. */
export const OpenBuybackSchema = z.looseObject({
  percent: finite,
  amount: finite,
  vault_percent: finite.optional(),
  vault_amount: finite.optional(),
  instant_deadline_ms: finite.optional(),
  firm: z.boolean().optional(),
});

// --- actions/wallet.ts ------------------------------------------------------

/** GET /store/credits — nested `wallet` block used by getWallet().
 *  The backend returns `{ wallet: { balance, available, is_frozen },
 *  transactions: [...] }`. getWallet() extracts
 *  `(raw as { wallet? }).wallet` and parses it with this schema. */
export const WalletSchema = z.looseObject({
  balance: finite,
  available: finite,
  is_frozen: z.boolean(),
  // Playthrough withdrawal gate: withdrawable is 0 until playthrough.remaining
  // hits 0 (lifetime deposits fully spent on pack opens). Both fields are
  // optional (mirroring OddsEntrySchema.marketPriceMyr) so a deploy-skew
  // backend missing them still parses; the consumer applies safe fallbacks.
  // When playthrough is present its inner shape stays strict.
  withdrawable: finite.optional(),
  playthrough: z
    .looseObject({
      deposited: finite,
      used: finite,
      remaining: finite,
    })
    .optional(),
});

// --- actions/vip.ts ---------------------------------------------------------

/** GET /store/vip — VIP level, cumulative spend, and next-rung teaser.
 *  Fields mirror the route's `res.json(...)` shape exactly (snake_case). */
export const VipSchema = z.looseObject({
  level: finite,
  highest_level_ever: finite,
  spend: finite,
  next: z
    .looseObject({
      level: finite,
      threshold: finite,
      remaining: finite,
      reward: z.looseObject({
        voucher_amount: finite,
        box_tier: z.string(),
        frame_unlock: z.boolean(),
      }),
    })
    .nullable(),
  levels: z
    .array(
      z.looseObject({
        level: finite,
        threshold: finite,
        reward: z.looseObject({
          voucher_amount: finite,
          box_tier: z.string(),
          frame_unlock: z.boolean(),
        }),
      }),
    )
    .default([]),
});

// --- actions/notifications.ts -----------------------------------------------

/** GET /store/notifications — single notification row in the feed. */
export const NotificationSchema = z.looseObject({
  id: z.string(),
  template: z.string(),
  data: z.looseObject({}).nullable().optional(),
  created_at: z.string(),
  read_at: z.union([z.string(), z.date()]).nullable(),
});

/** GET /store/notifications — outer envelope (notifications array + unread_count).
 *  `has_more` (pagination) is optional so an older backend still parses. */
export const NotificationsEnvelopeSchema = z.looseObject({
  unread_count: finite,
  has_more: z.boolean().optional(),
});

/** POST /store/notifications/:id/read — mark-read response. */
export const MarkReadSchema = z.looseObject({
  id: z.string(),
  read_at: z.union([z.string(), z.date()]),
});

/** POST /store/notifications/read-all — bulk mark-read response. */
export const MarkAllReadSchema = z.looseObject({
  marked: finite,
  read_at: z.union([z.string(), z.date()]),
});

// --- actions/daily.ts --------------------------------------------------------

/** A VIP voucher/frame grant row (GET /store/daily `vouchers.claimable|claimed`
 *  and the pre-consolidation GET /store/rewards `grants`). `status` is optional:
 *  the daily-state grant rows (packs/service.ts `GrantView`) never carry it —
 *  only the legacy rewards envelope did. `level` is a required top-level field:
 *  `GrantView` (packs/service.ts:199-205) declares `level: number`, and
 *  `toGrantView` (packs/service.ts:3223-3229) always sources it from the
 *  `VipRewardGrant.level` column (`model.number()`, non-nullable). `kind` and
 *  `origin` still admit 'box': the daily box is gone, but historical grant rows
 *  that carry it must keep parsing. */
export const RewardGrantSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['voucher', 'frame', 'box', 'prize']),
  status: z.enum(['granted', 'fulfilled', 'revoked']).optional(),
  level: finite,
  origin: z.enum(['ladder', 'box']).optional(),
  payload: z.looseObject({}).nullable().optional(),
  granted_at: z.string(),
});

/** Address input for prize withdrawal (subset of AddAddressInput). Defined here
 *  because this module is the app's sole `zod` importer (eslint no-restricted-imports). */
export const WithdrawAddressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  address1: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().min(1),
  countryCode: z.string().min(2).max(2),
});
export type WithdrawAddressInput = z.infer<typeof WithdrawAddressSchema>;

/** POST /store/rewards/claim/:grantId response. */
export const ClaimGrantSchema = z.looseObject({
  claimed: z.boolean(),
  kind: z.string(),
});

/** POST /store/rewards/withdraw response. */
export const WithdrawPrizeSchema = z.looseObject({
  status: z.enum(['requested', 'capped', 'invalid']),
});

/** GET /store/daily — the VIP voucher/frame grant state (packs/service.ts
 *  `DailyState`). The box and ship-prize halves went with the daily box
 *  (2026-08-25). */
export const DailyStateSchema = z.looseObject({
  redemption_enabled: z.boolean(),
  vouchers: z.looseObject({
    claimable: z.array(RewardGrantSchema),
    claimed: z.array(RewardGrantSchema),
  }),
});

// --- actions/delivery.ts ----------------------------------------------------

/** GET /store/delivery-orders item — guards the fields the mapper consumes. */
export const DeliveryOrderSchema = z.looseObject({
  id: z.string(),
  // TRANSITIONAL (one release): old ∪ new status vocabulary. During a deploy the
  // storefront ships before/after the backend, so an old backend can still emit
  // `packing`/`delivered` — and parseList DROPS a row that fails the schema, i.e.
  // a stale status would make the customer's order VANISH from /orders rather
  // than render with an odd label. Narrow to the 6 new values next release.
  status: z.enum([
    'requested',
    'packing',
    'processed',
    'ready_to_ship',
    'shipped',
    'delivered',
    'completed',
    'canceled',
  ]),
  created_at: z.string(),
  tracking_number: z.string().nullable().optional(),
  // The backend has always sent the full shipping snapshot (delivery-view.ts);
  // only name/city/country_code were declared, so the rest was silently dropped
  // by the view mapping. The street lines are OPTIONAL here on purpose: an old
  // backend that omits them must still parse, or parseList drops the whole row
  // and the customer's order vanishes from /orders.
  address: z
    .looseObject({
      name: z.string(),
      address_1: z.string().nullable().optional(),
      address_2: z.string().nullable().optional(),
      city: z.string(),
      province: z.string().nullable().optional(),
      postal_code: z.string().nullable().optional(),
      country_code: z.string(),
      phone: z.string().nullable().optional(),
    })
    .optional(),
  items: z
    .array(
      z.looseObject({
        pull_id: z.string(),
        card: z
          .looseObject({
            handle: z.string(),
            name: z.string(),
            image: z.string(),
          })
          .nullable(),
      }),
    )
    .optional(),
});

/** Single source of truth for the delivery status union (see the note above). */
export type DeliveryOrderStatus = z.infer<typeof DeliveryOrderSchema>['status'];

// --- data/cards.ts ------------------------------------------------------------

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
  marketPriceMyr: finite,
  rarity: rarity.nullable().catch(null),
  pcSyncedAt: z.string().nullable().catch(null),
  priceHistory: z.array(CardPricePointSchema).catch([]),
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

/** GET /store/referral — the /task Referral tab payload. */
export const ReferralSummarySchema = z.looseObject({
  handle: z.string(),
  downline_count: finite,
  week: z.looseObject({
    start: z.string(),
    turnover_cents: finite,
    rate_bp: finite,
    projected_cents: finite,
    partner: z.boolean(),
  }),
  history: z.array(SettlementHistoryRowSchema),
});
export type ReferralSummary = z.infer<typeof ReferralSummarySchema>;

/** One task row of GET /store/tasks (Phase B). requirement/reward are the
 *  backend's discriminated unions; the tab renders from progress + reward, so
 *  both stay loose JSON here (deploy-skew rule: an unknown new requirement
 *  type must not crash the page). */
export const TaskEntrySchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['weekly', 'achievement']),
  title: z.string(),
  requirement: z.looseObject({ type: z.string() }),
  reward: z.looseObject({ type: z.string() }),
  progress: z.looseObject({
    current: finite,
    target: finite,
    completed: z.boolean(),
  }),
  claimed: z.boolean(),
});
export type TaskEntry = z.infer<typeof TaskEntrySchema>;

/** GET /store/tasks — the /task Tasks tab payload. */
/** One unspent free-rip entitlement (GET /store/tasks `pending_spins`). */
export const PendingSpinSchema = z.looseObject({
  claim_id: z.string(),
  task_id: z.string(),
  title: z.string(),
  pack_id: z.string(),
});

export const TaskHubSchema = z.looseObject({
  week_start: z.string(),
  vip_level: finite,
  checked_in_today: z.boolean(),
  // `.catch([])` is the deploy-skew guard: a backend that predates the field
  // must not drop the whole hub payload and blank the page.
  pending_spins: z.array(PendingSpinSchema).catch([]),
  tasks: z.array(TaskEntrySchema),
});
export type TaskHub = z.infer<typeof TaskHubSchema>;
