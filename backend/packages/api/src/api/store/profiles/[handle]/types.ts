// The JSON body of GET /store/profiles/:handle, written once (ADR 0018). Types
// only. No imports: the storefront typecheck reads this file (as
// `@acme/api/store/profiles/[handle]`) without the backend's node_modules.

/** Display tiers, apex first (modules/packs/rarity.ts). */
export type StoreProfileRarity =
  'Immortal' | 'Legendary' | 'Mythical' | 'Rare' | 'Uncommon' | 'Common';

export type StoreProfileCard = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  /** Raw USD FMV. */
  market_value: number;
  /** Live MYR display value. */
  marketPriceMyr: number;
  image: string;
  slab_image: string | null;
};

/** A showcased card; `rarity` null = the odds row is gone (renders frameless). */
export type StoreProfileShowcaseCard = StoreProfileCard & {
  rarity: StoreProfileRarity | null;
};

export type StoreProfilePull = {
  pack_id: string;
  rarity: StoreProfileRarity;
  rolled_at: string;
  card: StoreProfileCard;
};

export type StoreProfileResponse = {
  handle: string;
  name: string;
  seed: number;
  avatar_url: string | null;
  equipped_frame_level: number | null;
  joined_at: string;
  stats: {
    pulls: number;
    volume: number;
    by_rarity: Record<StoreProfileRarity, number>;
  };
  /** Showcased cards only. */
  collection: StoreProfileShowcaseCard[];
  recent: StoreProfilePull[];
};
