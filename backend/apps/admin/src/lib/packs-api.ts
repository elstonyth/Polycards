import { client } from './client';
import type { ComputedOdd, OddsRarity, SetEntry } from '@acme/odds-math';

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
  /** Pack-page hero scene (wide landscape) — /slots/<slug> stage only; null =
   *  the stage falls back to `image`. Tiles/selector always use `image`. */
  display_image: string | null;
  /** Instant ("sell on the spot") rate — flat rate (90) to 100, % of FMV.
   *  Later sells from the vault always pay the flat rate. */
  buyback_percent: number;
  boost: boolean;
  published_odds: PublishedOdds | null;
  /** RAW / GRADED / MIX composition of the prize pool — AUTO-DETECTED from the
   *  members' graders, never operator-set. Null = empty pool (nothing to infer
   *  from, which is not the same as "raw"). */
  group: 'RAW' | 'GRADED' | 'MIX' | null;
  /** Theoretical EV (RM) per odds set — s1 is the live default; s2/s3 are the
   *  alternate weight columns (NULL weights inherit 3→2→1 per card). Null when
   *  the pack has no priced pool. */
  ev: { s1: number | null; s2: number | null; s3: number | null };
  /** Theoretical RTP % per odds set — null exactly when the matching `ev` is. */
  rtp: { s1: number | null; s2: number | null; s3: number | null };
  /** EV/RTP implied by the PUBLISHED tier percentages (what the player is
   *  promised) vs. what the secret weights above actually pay. Null when the
   *  pack has no published odds. */
  pub_ev: number | null;
  pub_rtp: number | null;
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
  /** Hero scene; null clears it (stage falls back to `image`). */
  display_image: string | null;
  buyback_percent: number;
  boost: boolean;
  rank: number;
  status: 'active' | 'draft';
  published_odds?: PublishedOdds | null;
}

// No rarity here — rarity is a per-pack property (PackOdds), edited in each
// pack's win-rate editor, not on the card.
export interface AdminCard {
  id: string;
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number;
  image: string;
  /** Baked graded-slab composite (null for raw cards) — thumbnails prefer it. */
  slab_image: string | null;
  /** Stored sale price; `null` means "use FMV (market_value)". */
  price: number | null;
  for_sale: boolean;
  /** Linked PixelPokemon library entry id (Spec 2 §5) — the source of truth for
   *  the card's Pokémon; the two mirror fields below are its render cache. Null
   *  = unlinked (name-derivation fallback). The edit form round-trips this. */
  pixel_pokemon_id: string | null;
  /** Mirrored from the linked entry's dex (render cache); null → name-derived. */
  pokemon_dex: number | null;
  /** Mirrored from the linked entry's sprite (render cache); null → dex gif. */
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
  /** Slab-label text (dynamic-label spec §8) — printed on the baked PSA slab
   *  composite; null = blank (renders nothing). */
  label_year: string | null;
  label_note: string | null;
  /** When the card was registered (ISO) — the list's "Added" sort key. */
  created_at: string;
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
  /** PixelPokemon library id (the picker). Omit = inherit any id staged on the
   *  product (from-pricecharting); null = none; string = link it. */
  pixel_pokemon_id?: string | null;
  /** Display margin over FMV (1.2 = +20%) — the gacha-card home of "markup". */
  market_multiplier?: number;
  /** Slab-label text (§8). Omit = leave unset; null/blank = clear; string =
   *  value (max 64 chars, backend-trimmed). */
  label_year?: string | null;
  label_note?: string | null;
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
  /** PixelPokemon library id (the picker). undefined = picker untouched (leave
   *  the link + its mirrored sprite as-is), null = unlink + clear, string =
   *  link. Send it only when the operator changed the picker. */
  pixel_pokemon_id?: string | null;
  /** Explicit `null` unlinks the card from PriceCharting (reverts to manual
   *  pricing); `undefined` leaves the current link untouched. */
  pc_product_id?: string | null;
  pc_grade?: string | null;
  market_multiplier?: number;
  /** Slab-label text (§8). Omit = leave unset; null/blank = clear; string =
   *  value (max 64 chars, backend-trimmed). */
  label_year?: string | null;
  label_note?: string | null;
}

export interface OddsRow {
  card_id: string;
  name: string;
  image: string;
  /** Baked graded-slab composite (null for raw cards) — thumbnails prefer it. */
  slab_image: string | null;
  /** The card's tier IN THIS PACK (PackOdds.rarity) — editable per pack. */
  rarity: string;
  /** DISPLAY PRICE (FMV × fx × the card's markup), not raw FMV — §2.4. */
  market_value: number;
  /** Available physical units; `null` = untracked (infinite). */
  stock: number | null;
  weight: number;
  /** RAW set-2/3 basis points; null = this card inherits the previous set. The
   *  editor seeds its override inputs from these (not from pct_2/pct_3) so
   *  "overridden" stays distinguishable from "inherited". */
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
  /** Current win % = weight / Σweight × 100, per set (inheritance resolved). */
  pct: number;
  pct_2: number;
  pct_3: number;
  /** Admin-picked Top Hit display order (1-based; null = not a Top Hit). */
  top_hit_order: number | null;
}

export interface PackOddsResponse {
  pack: {
    slug: string;
    title: string;
    category: string;
    status: string;
    /** Pack price (RM) — the denominator of the editor's live RTP readout. */
    price: number;
    /** Auto-detected pool composition (§2.4.8); null = empty pool. */
    group: 'RAW' | 'GRADED' | 'MIX' | null;
  };
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
          // SetEntry = OddsInput + the set-2/3 overrides (number | null —
          // STRICT server-side, a string 400s). The response stays SET 1 only.
          mutate: (input: {
            $slug: string;
            entries: SetEntry[];
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
          // card_ids is ORDERED: index 0 = display order 1 (leftmost).
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
