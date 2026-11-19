// The JSON body of GET /store/packs/:slug, written once (ADR 0018). Types
// only. No imports: the storefront typecheck reads this file (as
// `@acme/api/store/packs/[slug]`) without the backend's node_modules.

/** The detail's pack: the catalog row without the pool composition or the
 *  display image. */
export type StorePackDetailPack = {
  slug: string;
  title: string;
  category: string;
  prize_type: 'cards' | 'tickets';
  price: number;
  image: string;
  boost: boolean;
  buyback_percent: number;
  in_stock: boolean;
  /** Admin tag; null = untagged. */
  pack_type: 'classic' | 'original' | 'special' | null;
  /** Only an original pack has one. */
  language: 'en' | 'jp' | null;
  rank: number;
  status: string;
};

/** A card pack's pool row. The per-card weight is secret and never sent. */
export type StoreOddsCardRow = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  rarity: string;
  /** Raw USD FMV, for sorting only. */
  market_value: number;
  image: string;
  slab_image: string | null;
  /** Admin-picked Top Hit order (1-based); null = not one. */
  top_hit_order: number | null;
  pokemon_dex: number | null;
  sprite_image: string | null;
  /** Live MYR display price. */
  marketPriceMyr: number;
};

/** A ticket pack's pool row: one per amount. */
export type StoreOddsTicketRow = {
  handle: string;
  tickets: number;
  name: string;
  rarity: string;
  market_value: number;
  image: string;
};

export type StorePublishedOdds = {
  overall: number;
  tiers: Partial<Record<string, number>>;
  decimals: number;
};

export type StorePackDetailResponse = {
  prize_type: 'cards' | 'tickets';
  pack: StorePackDetailPack;
  odds: (StoreOddsCardRow | StoreOddsTicketRow)[];
  /** null = not published (the odds panel is hidden). */
  published_odds: StorePublishedOdds | null;
  demo_odds: null;
};
