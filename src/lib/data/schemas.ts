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

// --- data/packs.ts ----------------------------------------------------------

/** GET /store/packs row — getter checks `category` + finite `price` only. */
export const PackRowSchema = z.looseObject({
  category: z.string(),
  price: finite,
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
  // `firm` is false when the backend priced the quote on its FX display
  // fallback — selling would be refused, so the UI must not offer it as firm.
  // Optional: an older backend omits it (treated as firm).
  buyback: z.looseObject({
    amount: finite,
    percent: finite,
    firm: z.boolean().optional(),
  }),
});

/** POST /store/vault/:id/showcase response — pull_id + final showcased state. */
export const VaultShowcaseSchema = z.looseObject({
  pull_id: z.string(),
  showcased: z.boolean(),
});

/** GET /store/credits — finite balance. */
export const BalanceSchema = z.looseObject({ balance: finite });

/** GET /store/credits — lifetime totals (balance is also validated by BalanceSchema). */
export const CreditsSchema = z.looseObject({
  balance: finite,
  topup_total: finite,
  spend_total: finite,
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
  'direct_referral',
  'team_override',
  'commission_reversal',
  'cashout',
  'voucher_claim',
  'reward_credit',
  'daily_reward',
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
 *  The backend returns `{ wallet: { balance, available, locked, is_frozen,
 *  next_unlock }, transactions: [...] }`. getWallet() extracts
 *  `(raw as { wallet? }).wallet` and parses it with this schema. */
export const WalletSchema = z.looseObject({
  balance: finite,
  available: finite,
  locked: finite,
  is_frozen: z.boolean(),
  next_unlock: z.looseObject({ amount: finite, date: z.string() }).nullable(),
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
});

// --- actions/referral.ts ----------------------------------------------------

/** GET /store/referral — referral summary for the authenticated customer. */
export const ReferralSummarySchema = z.looseObject({
  directRecruits: z.array(
    z.looseObject({ handle: z.string().nullable(), contribution: finite }),
  ),
  downstreamCount: finite,
  totalEarned: finite,
});

/** POST /store/referral — apply-referral response (just the new link id). */
export const ReferralApplySchema = z.looseObject({ id: z.string() });

// --- actions/notifications.ts -----------------------------------------------

/** GET /store/notifications — single notification row in the feed. */
export const NotificationSchema = z.looseObject({
  id: z.string(),
  template: z.string(),
  data: z.looseObject({}).nullable().optional(),
  created_at: z.string(),
  read_at: z.union([z.string(), z.date()]).nullable(),
});

/** GET /store/notifications — outer envelope (notifications array + unread_count). */
export const NotificationsEnvelopeSchema = z.looseObject({
  unread_count: finite,
});

/** POST /store/notifications/:id/read — mark-read response. */
export const MarkReadSchema = z.looseObject({
  id: z.string(),
  read_at: z.union([z.string(), z.date()]),
});

// --- actions/daily.ts --------------------------------------------------------

/** A VIP voucher/frame grant row (GET /store/daily `vouchers.claimable|claimed`
 *  and the pre-consolidation GET /store/rewards `grants`). `status` is optional:
 *  the daily-state grant rows (packs/service.ts `GrantView`) never carry it —
 *  only the legacy rewards envelope did. `level` is a required top-level field:
 *  `GrantView` (packs/service.ts:199-205) declares `level: number`, and
 *  `toGrantView` (packs/service.ts:3223-3229) always sources it from the
 *  `VipRewardGrant.level` column (`model.number()`, non-nullable) — including
 *  box-origin grants, which set it explicitly via `resolveMemberLevel` (never
 *  null/undefined), NOT from `payload` (box grants' payload only carries
 *  `amount_myr`). */
export const RewardGrantSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['voucher', 'frame', 'box', 'prize']),
  status: z.enum(['granted', 'fulfilled', 'revoked']).optional(),
  level: finite,
  origin: z.enum(['ladder', 'box']).optional(),
  payload: z.looseObject({}).nullable().optional(),
  granted_at: z.string(),
});

/** A vaulted reward-prize row (GET /store/daily `ship_prizes`, and the
 *  pre-consolidation GET /store/rewards `prizes`). `voucher` is included
 *  because box draws can mint a voucher prize alongside product/credit. */
export const RewardPrizeSchema = z.looseObject({
  pull_id: z.string(),
  prize_kind: z.enum(['product', 'credit', 'voucher', 'nothing']),
  prize_snapshot: z.looseObject({}).nullable().optional(),
  status: z.string(),
  draw_day: z.string(),
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

/** POST /store/daily/draw response (packs/service.ts `DrawDailyBoxResult`). */
export const DrawBoxSchema = z.looseObject({
  status: z.enum(['drawn', 'unavailable', 'capped']),
  prize: z
    .looseObject({
      kind: z.enum(['product', 'credit', 'voucher', 'nothing']),
      title: z.string().optional(),
      image: z.string().optional(),
      amount_myr: finite.optional(),
      product_handle: z.string().optional(),
    })
    .optional(),
  draw_ordinal: finite.optional(),
});

/** POST /store/rewards/withdraw response. */
export const WithdrawPrizeSchema = z.looseObject({
  status: z.enum(['requested', 'capped', 'invalid']),
});

/** GET /store/daily box view (packs/service.ts `DailyState['box']`). */
const DailyBoxSchema = z.looseObject({
  tier: z.string(),
  name: z.string(),
  draws_per_day: finite,
  draws_today: finite,
  next_reset: z.string(),
  prizes: z.array(
    z.looseObject({
      kind: z.enum(['credit', 'product', 'voucher', 'nothing']),
      title: z.string().optional(),
      image: z.string().optional(),
      amount_myr: finite.optional(),
    }),
  ),
});

/** GET /store/daily — consolidated daily-rewards state (packs/service.ts
 *  `DailyState`). `box` is nullable: no VIP tier resolves to a box yet. */
export const DailyStateSchema = z.looseObject({
  redemption_enabled: z.boolean(),
  box: DailyBoxSchema.nullable(),
  vouchers: z.looseObject({
    claimable: z.array(RewardGrantSchema),
    claimed: z.array(RewardGrantSchema),
  }),
  ship_prizes: z.array(RewardPrizeSchema),
});

// --- actions/delivery.ts ----------------------------------------------------

/** GET /store/delivery-orders item — guards the fields the mapper consumes. */
export const DeliveryOrderSchema = z.looseObject({
  id: z.string(),
  status: z.enum(['requested', 'packing', 'shipped', 'delivered', 'canceled']),
  created_at: z.string(),
  tracking_number: z.string().nullable().optional(),
  address: z
    .looseObject({
      name: z.string(),
      city: z.string(),
      country_code: z.string(),
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
