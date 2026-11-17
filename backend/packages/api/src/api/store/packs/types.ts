// The JSON body of GET /store/packs (and GET /store/customers/me/draft-packs,
// which sends the same rows), written once (ADR 0018). Types only. No imports:
// the storefront typecheck reads this file (as `@acme/api/store/packs`)
// without the backend's node_modules.

export type StorePackRow = {
  slug: string;
  title: string;
  category: string;
  prize_type: 'cards' | 'tickets';
  /** RM, a decimal. */
  price: number;
  image: string;
  display_image: string | null;
  boost: boolean;
  /** The Lossless Mode rate inside a window. */
  buyback_percent: number;
  in_stock: boolean;
  /** Pool composition; null = empty pool. */
  group: 'GRADED' | 'RAW' | 'MIX' | null;
  /** Every pooled card is a PSA 10. */
  psa10: boolean;
  rank: number;
  status: string;
};

export type StorePacksResponse = { packs: StorePackRow[] };
