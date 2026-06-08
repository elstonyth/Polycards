import { client } from "./client";
import type { ComputedOdd, OddsInput } from "./odds-math";

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

export interface AdminPack {
  slug: string;
  title: string;
  category: string;
  status: "active" | "draft";
  rank: number;
  price: number;
  image: string;
}

export interface OddsRow {
  card_id: string;
  name: string;
  image: string;
  rarity: string;
  market_value: number;
  weight: number;
  locked: boolean;
  /** Current win % = weight / Σweight × 100. */
  pct: number;
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
  card: {
    handle: string;
    name: string;
    rarity: string;
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
  pulls: PullRow[];
  topCards: TopCard[];
  topRarities: TopRarity[];
}

type PacksApi = {
  admin: {
    packs: {
      query: () => Promise<{ packs: AdminPack[] }>;
      $slug: {
        odds: {
          query: (input: { $slug: string }) => Promise<PackOddsResponse>;
          mutate: (input: {
            $slug: string;
            entries: OddsInput[];
          }) => Promise<{ odds: ComputedOdd[] }>;
        };
      };
    };
    pulls: {
      query: () => Promise<PullsResponse>;
    };
  };
};

export const packsApi = client as unknown as PacksApi;
