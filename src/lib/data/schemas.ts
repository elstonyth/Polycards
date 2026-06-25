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

/** GET /store/packs/:slug odds row — handle + known rarity + finite value. */
export const OddsEntrySchema = z.looseObject({
  handle: z.string(),
  rarity,
  market_value: finite,
});

/** GET /store/pulls/recent row — handle + name + known rarity + finite value. */
export const RecentPullSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
});

// --- data/leaderboard.ts ----------------------------------------------------

/** GET /store/leaderboard row — name + finite points/volume/pulls. */
export const LeaderboardEntrySchema = z.looseObject({
  name: z.string(),
  points: finite,
  volume: finite,
  pulls: finite,
});

// --- data/profiles.ts -------------------------------------------------------

/** GET /store/profiles/:handle — handle string + a stats object present. */
export const PublicProfileSchema = z.looseObject({
  handle: z.string(),
  stats: z.looseObject({}),
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
  buyback: z.looseObject({ amount: finite, percent: finite }),
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
 *  backend models/credit-transaction.ts). The single storefront source of truth:
 *  the schema enum, the `CreditTxn.reason` type, and the `REASON_LABEL` map all
 *  derive from this list, so a newly-added backend reason can't be silently
 *  dropped by `parseList` (it would just need a label, which TS then demands). */
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
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

/** GET /store/credits transaction row. `amount` is signed (credit +, spend −). */
export const CreditTransactionSchema = z.looseObject({
  id: z.string(),
  amount: finite,
  reason: z.enum(CREDIT_REASONS),
  created_at: z.string(),
});

/** POST /store/credits/topup response — finite amount + balance. */
export const AmountBalanceSchema = z.looseObject({
  amount: finite,
  balance: finite,
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

/** Open-route `card` — handle + name + known rarity + finite market_value. */
export const WonCardSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
  pokemon_dex: z.number().nullable().optional(),
  sprite_image: z.string().nullable().optional(),
});

/** Open-route `buyback` offer — instant percent/amount (required) + the vault
 *  rate/amount and instant deadline (optional; older backends omit them). */
export const OpenBuybackSchema = z.looseObject({
  percent: finite,
  amount: finite,
  vault_percent: finite.optional(),
  vault_amount: finite.optional(),
  instant_deadline_ms: finite.optional(),
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

// --- actions/rewards.ts -----------------------------------------------------

/** GET /store/rewards grant row (claimable voucher or frame). */
export const RewardGrantSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['voucher', 'frame', 'box', 'prize']),
  status: z.enum(['granted', 'fulfilled', 'revoked']),
  payload: z.looseObject({}).nullable().optional(),
  granted_at: z.string(),
});

/** GET /store/rewards draw state (daily box). */
export const RewardDrawStateSchema = z.looseObject({
  draws_today: finite,
  draws_per_day: finite,
  pool_enabled: z.boolean(),
  tier: z.string(),
});

/** GET /store/rewards vaulted prize row. */
export const RewardPrizeSchema = z.looseObject({
  pull_id: z.string(),
  prize_kind: z.enum(['product', 'credit', 'nothing']),
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

/** GET /store/rewards outer envelope. */
export const RewardsEnvelopeSchema = z.looseObject({
  grants: z.array(z.looseObject({})).optional(),
  draw_state: z.looseObject({}).nullable().optional(),
  prizes: z.array(z.looseObject({})).optional(),
  redemption_enabled: z.boolean().optional(),
});

/** POST /store/rewards/claim/:grantId response. */
export const ClaimGrantSchema = z.looseObject({
  claimed: z.boolean(),
  kind: z.string(),
});

/** POST /store/rewards/draw response. */
export const DrawBoxSchema = z.looseObject({
  status: z.enum(['drawn', 'unavailable', 'capped']),
  prize: z
    .looseObject({
      kind: z.enum(['product', 'credit', 'nothing']),
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
