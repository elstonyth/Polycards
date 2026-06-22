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

/** GET /store/credits transaction row. `amount` is signed (credit +, spend −). */
export const CreditTransactionSchema = z.looseObject({
  id: z.string(),
  amount: finite,
  // Must cover EVERY reason the backend ledger emits, or parseList silently
  // DROPS the row — VIP commission rows (direct_referral/team_override/
  // commission_reversal) and cashout would vanish from the customer's history
  // and stop reconciling to the displayed balance.
  reason: z.enum([
    'buyback',
    'topup',
    'pack_open',
    'adjustment',
    'direct_referral',
    'team_override',
    'commission_reversal',
    'cashout',
  ]),
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
