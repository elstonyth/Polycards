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
  /** Why it is locked, so the explainer can say the true thing. The two
   *  reasons share nothing: a free pull unlocks on the first paid open, a
   *  reward card never unlocks at all. Null when unlocked. */
  lockReason: 'free_pull' | 'reward' | null;
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

export interface BackendVaultItem {
  pull_id: string;
  rolled_at: string;
  pack_id: string;
  pack_title: string;
  /** Absent on an older backend → false (the pre-prism behaviour). */
  challenge_prize?: boolean;
  /** Absent on an older backend → 'pack' / false (see VaultItemSchema). */
  source?: 'pack' | 'reward' | 'free';
  locked?: boolean;
  lock_reason?: 'free_pull' | 'reward' | null;
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
    showcased: (i as unknown as { showcased?: boolean }).showcased ?? false,
    source: i.source ?? 'pack',
    locked: i.locked ?? false,
    // A backend that predates lock_reason only ever locked free pulls, so
    // that is the honest fallback.
    lockReason: (i.locked ?? false) ? (i.lock_reason ?? 'free_pull') : null,
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
