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

/** GET /store/vault item — pull_id + card.name + finite buyback.amount. */
export const VaultItemSchema = z.looseObject({
  pull_id: z.string(),
  card: z.looseObject({ name: z.string() }),
  buyback: z.looseObject({ amount: finite }),
});

/** GET /store/credits — finite balance. */
export const BalanceSchema = z.looseObject({ balance: finite });

/** POST /store/credits/topup + buyback responses — finite amount + balance. */
export const AmountBalanceSchema = z.looseObject({
  amount: finite,
  balance: finite,
});

// --- actions/packs.ts -------------------------------------------------------

/** Open-route `card` — handle + name + known rarity + finite market_value. */
export const WonCardSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
});

/** Open-route `buyback` offer — finite percent + amount (both required). */
export const OpenBuybackSchema = z.looseObject({
  percent: finite,
  amount: finite,
});
