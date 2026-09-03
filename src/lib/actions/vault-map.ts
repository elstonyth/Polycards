/**
 * Pure mapper for a single raw /store/vault item.
 *
 * Extracted from the 'use server' boundary (same pattern as pack-batch-map.ts)
 * so the firm-default logic can be unit-tested without the Next.js
 * server-action constraint. Nothing here is server-only.
 */

export type VaultItem = {
  pullId: string;
  rolledAt: string;
  packId: string;
  packTitle: string;
  /** Won in the Weekly Pulled Value Challenge. Such a card keeps the
   *  challenge's prism frame here instead of taking the card's pack tier — it
   *  was won there, not pulled from a pack. */
  challengePrize: boolean;
  showcased: boolean;
  /** How the pull was acquired. Display/telemetry only — see `locked`. */
  source: 'pack' | 'reward' | 'free';
  /** Sell + delivery are refused server-side (the free welcome pull, until the
   *  account's first PAID open). EVERY lock affordance must key off THIS, never
   *  `source`: a weekly-challenge prize is source='reward' and fully sellable. */
  locked: boolean;
  /** Can it be SOLD? The backend's answer; since 2026-09-03 it equals
   *  `!locked` (task/achievement rewards sell like any card), but the vault
   *  keys its Sell affordance off THIS so the backend stays the authority. */
  sellable: boolean;
  card: {
    handle: string;
    name: string;
    image: string;
    slabImage: string | null;
    rarity: string;
    marketValue: number;
    marketPriceMyr: number;
  };
  buyback: {
    percent: number;
    amount: number;
    /** false = quoted on the FX display fallback; the sell would be refused,
     *  so CTAs must not present the amount as a firm offer. */
    firm: boolean;
  };
};

/**
 * The raw /store/vault row as this mapper reads it.
 *
 * NOT a twin of `VaultItemSchema`: the schema declares only the fields whose
 * absence must DROP the row (pull_id, card.name, buyback.amount/percent), plus
 * the `.catch()`-defaulted source/locked/sellable and optional showcased. Every
 * other field the mapper reads rides through the `looseObject` unguarded on
 * purpose — requiring them would let a stale field delete a card from the
 * customer's own vault — so `parseList`'s output type cannot describe them and
 * the two declarations genuinely differ. Keep the names below in step with
 * `VaultItemSchema` by hand.
 *
 * WHICH `??` DEFAULTS BELOW ARE DEAD, exactly — do not generalise this:
 * only `source`, `locked` and `sellable` are guaranteed by the schema's
 * `.catch()` (which defaults a MISSING key, not just an invalid one), so only
 * those three coalesces are unreachable in production. Every other `??` here is
 * LIVE and load-bearing: `challenge_prize` is not in `VaultItemSchema` at all,
 * `showcased` and `buyback.firm` are `.optional()` (no default), and
 * `card.slab_image` / `card.marketPriceMyr` are unguarded. Dropping
 * `challenge_prize ?? false` would put `undefined` behind a `boolean` for any
 * backend predating the field — every customer's vault silently loses the prism
 * frame on challenge prizes, with no type error to catch it.
 */
export interface BackendVaultItem {
  pull_id: string;
  rolled_at: string;
  pack_id: string;
  pack_title: string;
  /** Absent on an older backend → false (the pre-prism behaviour). */
  challenge_prize?: boolean;
  /** Guarded by VaultItemSchema (optional there too) — declared here so the
   *  mapper reads it directly instead of casting past its own input type. */
  showcased?: boolean;
  /** Absent on an older backend → 'pack' / false (see VaultItemSchema). */
  source?: 'pack' | 'reward' | 'free';
  locked?: boolean;
  sellable?: boolean;
  card: {
    handle: string;
    name: string;
    image: string;
    slab_image?: string | null;
    rarity: string;
    market_value: number;
    marketPriceMyr?: number;
  };
  buyback: { percent: number; amount: number; firm?: boolean };
}

export function mapVaultItem(i: BackendVaultItem): VaultItem {
  return {
    pullId: i.pull_id,
    rolledAt: i.rolled_at,
    packId: i.pack_id,
    packTitle: i.pack_title,
    challengePrize: i.challenge_prize ?? false,
    showcased: i.showcased ?? false,
    source: i.source ?? 'pack',
    locked: i.locked ?? false,
    // Defaults true — a backend without the field behaves as it always did.
    sellable: (i.sellable ?? true) && !(i.locked ?? false),
    card: {
      handle: i.card.handle,
      name: i.card.name,
      image: i.card.image,
      slabImage: i.card.slab_image ?? null,
      rarity: i.card.rarity,
      marketValue: i.card.market_value,
      marketPriceMyr: i.card.marketPriceMyr ?? 0,
    },
    buyback: {
      percent: i.buyback.percent,
      amount: i.buyback.amount,
      // Absent on an older backend = firm (pre-firmness behavior).
      firm: i.buyback.firm ?? true,
    },
  };
}
