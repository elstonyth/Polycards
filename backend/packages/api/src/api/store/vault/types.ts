// The JSON body of GET /store/vault, written once (ADR 0018). Types only.
// No imports: the storefront typecheck reads this file (as
// `@acme/api/store/vault`) without the backend's node_modules.

export type StoreVaultCard = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  /** '' on a Lucky Draw prize, which states no tier. */
  rarity: string;
  /** Raw USD FMV. */
  market_value: number;
  image: string;
  slab_image: string | null;
  /** Live MYR display price (FMV × FX × markup). */
  marketPriceMyr: number;
  pokemon_dex: number | null;
  sprite_image: string | null;
};

/** A live quote, or the "no quote" block on a locked pull (UNQUOTED_BUYBACK
 *  with the real FX `firm`). */
export type StoreVaultBuyback = {
  percent: number;
  amount: number;
  /** false when the amount used the display FX fallback. */
  firm: boolean;
  /** The part of `amount` from bonus play (live quote only). */
  bonus?: number;
  rate_type?: 'instant' | 'vault';
  vault_percent?: number;
  vault_amount?: number;
};

export type StoreVaultItem = {
  pull_id: string;
  rolled_at: string;
  pack_id: string;
  pack_title: string;
  challenge_prize: boolean;
  lucky_draw_prize: boolean;
  showcased: boolean;
  card: StoreVaultCard;
  source: 'pack' | 'reward' | 'free' | 'gift' | 'bonus';
  locked: boolean;
  bonus_bp: number;
  sellable: boolean;
  buyback: StoreVaultBuyback;
};

export type StoreVaultResponse = { items: StoreVaultItem[] };
