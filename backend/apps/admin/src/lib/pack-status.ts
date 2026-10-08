// The status the admin shows. Sold out is not a stored status: it is an ACTIVE
// pack with in_stock=false — still listed on the storefront (greyed "Sold out"
// tile), but paid opens are refused. Kept apart from packs-api.ts so it stays
// importable in tests (packs-api pulls in the HTTP client).
export type PackStatus = 'active' | 'draft' | 'sold_out';

// `=== false` like every other reader: a row without the field is in stock.
export const packStatusOf = (p: {
  status: 'active' | 'draft';
  in_stock?: boolean;
}): PackStatus =>
  p.status === 'draft' ? 'draft' : p.in_stock === false ? 'sold_out' : 'active';

// Draft resets in_stock, so a pack never sits in a hidden fourth state.
export const packStatusWrite = (
  s: PackStatus,
): { status: 'active' | 'draft'; in_stock: boolean } => ({
  status: s === 'draft' ? 'draft' : 'active',
  in_stock: s !== 'sold_out',
});

export const PACK_STATUS_COLOR = {
  active: 'green',
  draft: 'grey',
  sold_out: 'orange',
} as const;

export const PACK_STATUS_LABEL = {
  active: 'packs.form.active',
  draft: 'packs.form.draft',
  sold_out: 'packs.form.soldOut',
} as const;
