/**
 * Pure helpers for mapping a single raw open-batch roll into a `BatchRoll`.
 *
 * Extracted from the 'use server' boundary so this module can be imported by
 * unit tests without the Next.js server-action constraint (which disallows
 * non-async named exports).
 *
 * Nothing in here is server-only — no SDK, no auth, no secrets.
 */
import { formatValue } from '@/lib/packs-format';
import { parseOne, WonCardSchema, OpenBuybackSchema } from '@/lib/data/schemas';
import type { Rarity } from '@/lib/packs-data';
import type { WonCard } from './packs';

/** Inline buyback offer shape — shared between openPack and openBatch. */
export type BuybackOffer = {
  percent: number;
  amount: number;
  vaultPercent: number | null;
  vaultAmount: number | null;
  instantDeadlineMs: number | null;
};

/** One roll in an open-batch response, mapped for the client reveal. */
export type BatchRoll = {
  card: WonCard;
  pullId: string | null;
  marketValue: number;
  buyback: BuybackOffer | null;
};

/** Raw shape of a single element inside the backend `rolls` array. */
export interface RawBatchRollItem {
  pull?: { id?: unknown };
  card: {
    handle: string;
    name: string;
    image: string;
    market_value: number;
    rarity: string;
    pokemon_dex?: number | null;
    sprite_image?: string | null;
    marketPriceMyr?: number;
    [key: string]: unknown;
  };
  buyback?: unknown;
}

/**
 * Clamp `n` to an integer in [1, 3].
 *
 * Exported so `openBatch` (and tests) share one source of truth instead of
 * duplicating the inline `Math.min/max/trunc` expression.
 */
export const clampCount = (n: number): number =>
  Math.min(3, Math.max(1, Math.trunc(n)));

/**
 * Map one raw roll item into a `BatchRoll`.
 *
 * Returns `null` if `WonCardSchema` validation fails — callers must treat a
 * null as a whole-batch failure (never return a partial batch).
 *
 * `image` is intentionally read from `rawRoll.card.image` (the raw object),
 * NOT from the validated `wonCard`, because `WonCardSchema` omits `image`
 * (consistent with how `openPack` maps its card).
 */
export function mapBatchRoll(rawRoll: RawBatchRollItem): BatchRoll | null {
  const wonCard = parseOne(WonCardSchema, rawRoll.card);
  if (!wonCard) return null;

  const offer = parseOne(OpenBuybackSchema, rawRoll.buyback);

  return {
    card: {
      id: wonCard.handle,
      name: wonCard.name,
      image: rawRoll.card.image, // ← RAW, not from parsed wonCard
      value: formatValue(wonCard.market_value),
      rarity: wonCard.rarity as Rarity,
      pokemon_dex: wonCard.pokemon_dex ?? null,
      sprite_image: wonCard.sprite_image ?? null,
      marketPriceMyr: wonCard.marketPriceMyr ?? null,
    },
    pullId: typeof rawRoll.pull?.id === 'string' ? rawRoll.pull.id : null,
    marketValue: wonCard.market_value,
    buyback: offer
      ? {
          percent: offer.percent,
          amount: offer.amount,
          vaultPercent: offer.vault_percent ?? null,
          vaultAmount: offer.vault_amount ?? null,
          instantDeadlineMs: offer.instant_deadline_ms ?? null,
        }
      : null,
  };
}
