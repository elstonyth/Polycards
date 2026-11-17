// The JSON body of GET /store/pulls/recent, written once (ADR 0018). Types
// only. No imports: the storefront typecheck reads this file (as
// `@acme/api/store/pulls/recent`) without the backend's node_modules.

/** The puller's PII-safe display fields (pulls/pullers.ts). */
export type StorePullerFields = {
  who: string;
  /** Typed nullable by the shared puller helper; this feed always seeds one. */
  seed: number | null;
  profile_handle: string | null;
  avatar_url: string | null;
  frame_url: string | null;
};

/** What every feed row carries, card or ticket. */
export type StoreRecentPullBase = StorePullerFields & {
  id: string;
  rarity: string;
  pack_id: string;
  /** null when the pack was deleted. */
  pack_title: string | null;
  pack_image: string | null;
  rolled_at: string;
};

/** A card pack's feed row. */
export type StoreRecentCardPull = StoreRecentPullBase & {
  handle: string;
  name: string;
  /** Raw USD FMV. */
  market_value: number;
  marketPriceMyr: number;
  image: string;
  slab_image: string | null;
  set: string;
  pokemon_dex: number | null;
  sprite_image: string | null;
};

/** A ticket pack's feed row: the amount won in place of a card. */
export type StoreRecentTicketPull = StoreRecentPullBase & {
  tickets: number;
};

export type StoreRecentPullsResponse = {
  pulls: (StoreRecentCardPull | StoreRecentTicketPull)[];
  /** Pulls since the last hit, per apex tier. */
  drought: Record<string, number>;
};
