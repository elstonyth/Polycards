import { client } from './client';
import type { ComputedOdd, OddsInput, OddsRarity } from '@acme/odds-math';

// Typed facade for the custom gacha admin routes.
//
// The shared `client` is a generic path-proxy from @mercurjs/client: a property
// chain becomes a URL and the leaf action picks the verb (`query` -> GET,
// `mutate` -> POST), with `$seg` keys substituted into the path. That works at
// RUNTIME for any route — but the compile-time `Routes` type (from
// @acme/api/_generated) is codegen'd from framework routes and does NOT include
// our custom /admin/packs endpoints. So we narrow `client` to a hand-written
// facade describing exactly those endpoints. (Cookie auth via credentials:
// 'include' in client.ts covers the auto-protected /admin/* routes.)

// PUBLIC display odds shown to players ({ overall win %, per-tier % }) —
// display-only, fully decoupled from the per-card win-rate weights.
export interface PublishedOdds {
  overall: number;
  tiers: Partial<Record<OddsRarity, number>>;
}

export interface AdminPack {
  slug: string;
  title: string;
  category: string;
  status: 'active' | 'draft';
  rank: number;
  price: number;
  image: string;
  /** Instant ("sell on the spot") rate — flat rate (90) to 100, % of FMV.
   *  Later sells from the vault always pay the flat rate. */
  buyback_percent: number;
  boost: boolean;
  published_odds: PublishedOdds | null;
}

// Create/update payload. `slug` is sent on create only (immutable thereafter —
// on update it travels as the `$slug` path param, not the body).
// `published_odds` OMITTED = keep the stored value; null = explicit clear.
export interface AdminPackWrite {
  slug?: string;
  title: string;
  category: string;
  price: number;
  image: string;
  buyback_percent: number;
  boost: boolean;
  rank: number;
  status: 'active' | 'draft';
  published_odds?: PublishedOdds | null;
}

// No rarity here — rarity is a per-pack property (PackOdds), edited in each
// pack's win-rate editor, not on the card.
export interface AdminCard {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  image: string;
  /** Stored sale price; `null` means "use FMV (market_value)". */
  price: number | null;
  for_sale: boolean;
  /** Assigned national-dex (1-based) or null → resolve from the name. */
  pokemon_dex: number | null;
  /** Custom uploaded pixel sprite URL or null → use the dex default gif. */
  sprite_image: string | null;
  /** Available physical units; `null` = untracked (infinite). Display-only —
   *  cards stay pullable at any count; wins keep decrementing below 0, so a
   *  negative value = units owed to winners. */
  stock: number | null;
  /** PriceCharting product id this card tracks, or null if unlinked. */
  pc_product_id: string | null;
  /** PriceCharting grade key (e.g. "PSA 10") this card tracks. */
  pc_grade: string | null;
  /** Display markup over FMV applied on top of `priceBreakdown.marketMyr`. */
  market_multiplier: number;
  /** Last time the daily PriceCharting sync updated this card's market_value. */
  pc_synced_at: string | null;
  /** USD -> MYR breakdown for the current market_value; always present (GET
   *  routes always resolve an fxRate before building the DTO). */
  priceBreakdown: {
    raw: number;
    fxRate: number;
    marketMyr: number;
    displayPrice: number;
    markup: number;
  };
}

// Registration payload (create): the item must already exist as an inventory
// product; only the gacha facts travel. Name/image/handle come from the product.
export interface AdminCardRegister {
  product_id: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  pokemon_dex: number | null;
  sprite_image: string | null;
  /** Display margin over FMV (1.2 = +20%) — the gacha-card home of "markup". */
  market_multiplier?: number;
}

// Edit payload. `handle` travels as the `$handle` path param, not the body.
export interface AdminCardUpdate {
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  image: string;
  price?: number;
  for_sale: boolean;
  pokemon_dex: number | null;
  sprite_image: string | null;
  /** Explicit `null` unlinks the card from PriceCharting (reverts to manual
   *  pricing); `undefined` leaves the current link untouched. */
  pc_product_id?: string | null;
  pc_grade?: string | null;
  market_multiplier?: number;
}

export interface OddsRow {
  card_id: string;
  name: string;
  image: string;
  /** The card's tier IN THIS PACK (PackOdds.rarity) — editable per pack. */
  rarity: string;
  market_value: number;
  /** Available physical units; `null` = untracked (infinite). */
  stock: number | null;
  weight: number;
  locked: boolean;
  /** Current win % = weight / Σweight × 100. */
  pct: number;
  /** Admin-picked Top Hit flag (storefront display only). */
  top_hit: boolean;
}

export interface PackOddsResponse {
  pack: { slug: string; title: string; category: string; status: string };
  odds: OddsRow[];
}

export interface PullRow {
  id: string;
  rolled_at: string;
  customer_id: string | null;
  customer_email: string | null;
  pack_id: string;
  pack_title: string | null;
  /** Vault lifecycle: still held vs instantly sold back. */
  status: 'vaulted' | 'bought_back';
  /** USD credited at buyback time; null while vaulted. */
  buyback_amount: number | null;
  card: {
    handle: string;
    name: string;
    /** Per-pack tier of the pull; null when the odds row no longer exists. */
    rarity: string | null;
    market_value: number;
    image: string;
  } | null;
}

export interface TopCard {
  handle: string;
  name: string;
  rarity: string | null;
  market_value: number | null;
  image: string | null;
  count: number;
}

export interface TopRarity {
  rarity: string;
  count: number;
}

export interface PullsResponse {
  total: number;
  offset: number;
  limit: number;
  pulls: PullRow[];
  topCards: TopCard[];
  topRarities: TopRarity[];
}

type PacksApi = {
  admin: {
    packs: {
      query: () => Promise<{ packs: AdminPack[] }>;
      mutate: (input: AdminPackWrite) => Promise<{ pack: { slug: string } }>;
      $slug: {
        query: (input: { $slug: string }) => Promise<{ pack: AdminPack }>;
        mutate: (
          input: { $slug: string } & AdminPackWrite,
        ) => Promise<{ pack: { slug: string } }>;
        odds: {
          query: (input: { $slug: string }) => Promise<PackOddsResponse>;
          mutate: (input: {
            $slug: string;
            entries: OddsInput[];
          }) => Promise<{ odds: ComputedOdd[] }>;
        };
        members: {
          query: (input: { $slug: string }) => Promise<{ members: string[] }>;
          mutate: (input: { $slug: string; card_ids: string[] }) => Promise<{
            pack_id: string;
            members: string[];
            added: number;
            removed: number;
          }>;
        };
        'top-hits': {
          mutate: (input: { $slug: string; card_ids: string[] }) => Promise<{
            top_hits: string[];
            changed: number;
          }>;
        };
      };
    };
    cards: {
      query: () => Promise<{ cards: AdminCard[] }>;
      mutate: (input: AdminCardRegister) => Promise<{
        card: { handle: string; productId: string };
      }>;
      $handle: {
        query: (input: { $handle: string }) => Promise<{ card: AdminCard }>;
        mutate: (
          input: { $handle: string } & AdminCardUpdate,
        ) => Promise<{ card: { handle: string; productId: string } }>;
      };
    };
  };
};

export const packsApi = client as unknown as PacksApi;
