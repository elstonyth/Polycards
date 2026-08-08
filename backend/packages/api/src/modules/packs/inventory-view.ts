import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import { getCardStockByHandle } from './card-stock';
import { isGraded } from './card-view';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from './pricing';
import { toMoney, toOptionalMoney } from './money';
import { pageAll } from '../../api/utils/page-all';

export type InventoryRow = {
  handle: string;
  product_id: string;
  photo: string | null;
  name: string;
  sku: string;
  is_card: boolean;
  graded: boolean; // title RAW/GRADED
  fmv: number | null; // MYR
  price: number | null; // MYR, FMV x multiplier
  cost: number | null; // MYR, D8 weighted average
  created_at: string | Date;
  on_hand: number | null;
  in_vault: number;
  requested: number;
  shipped: number;
  listing_count: number;
};

// "SKU" is the Medusa variant's, where one exists — spec §3.1: Card has NO sku
// column, the handle is the key. Same query.graph seam card-stock.ts uses over
// the same products.
async function skuByHandle(
  container: MedusaContainer,
  handles: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (handles.length === 0) return out;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: 'product',
    fields: ['handle', 'variants.sku'],
    filters: { handle: handles },
  });
  for (const row of data as Array<{
    handle: string | null;
    variants?: Array<{ sku?: string | null } | null> | null;
  }>) {
    if (!row.handle) continue;
    out.set(row.handle, row.variants?.[0]?.sku ?? null);
  }
  return out;
}

// Inventory's grain is PRODUCTS, not just registered gacha Cards — the importer
// that feeds this list (create-product-from-pricecharting) creates a Product
// with NO Card row, and "List to gacha card" only makes sense on a row that is
// not yet a card. The Card row wins when present; otherwise the row falls back
// to the product's own title + the gacha facts staged on product.metadata by
// that importer (the same fields admin/gacha/eligible-products/route.ts reads).
//
// in_vault / requested / shipped are three INDEPENDENT counts, not a partition:
// see inventoryLifecycleBuckets' own note — disjointness is convergent, not
// structural. Never derive a total by summing them; total physical units is
// on_hand, which comes from the authoritative Medusa counter.
export async function loadInventoryRows(
  container: MedusaContainer,
  opts: { q?: string; handle?: string; maxRows?: number } = {},
): Promise<InventoryRow[]> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const productModule = container.resolve(Modules.PRODUCT);

  // PAGED, never `take: N`: every column below is money or a count, and a
  // truncated read renders a plausible WRONG list instead of an obvious error
  // (Task 4's rule). The ROUTE is unpaged by design — on_hand/in_vault/
  // requested/shipped/cost are all computed after the products load, so the
  // admin can only sort on them client-side.
  //
  // The filter literal is rebuilt per page ON PURPOSE: Medusa's
  // applyFreeTextSearchFilter moves `q` onto the find config and then
  // `delete`s it from the filters object it was handed, so a hoisted object
  // would silently return the WHOLE catalog from page 2 onwards.
  //
  // `handle` is an EXACT scope (the item-detail route asks for one row), `q`
  // is the list's free-text search; they are never both set. handle is NOT
  // expressible as `q`: Medusa's free-text filter searches title / subtitle /
  // description plus the variants' searchable fields, and `handle` is not
  // `.searchable()` on Product -- `{ q: handle }` would silently miss the very
  // row it was asking for.
  const products = await pageAll((page) =>
    productModule.listProducts(
      opts.handle ? { handle: opts.handle } : opts.q ? { q: opts.q } : {},
      page,
    ),
  );
  const fx = await resolveFxRate(packs);

  const listed = products.filter(
    (p): p is typeof p & { handle: string } => !!p.handle,
  );

  // Enforced HERE, before the card read and the five aggregates below, not
  // after: `listed` maps 1:1 to the rows this function returns, so a huge
  // ?q= that busts the cap fails fast instead of paying for every downstream
  // read first. Only the export route passes maxRows -- list/detail leave it
  // unset, so this is a no-op for them (see loadInventoryRows' opts).
  if (opts.maxRows !== undefined && listed.length > opts.maxRows) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Inventory export matched ${listed.length} rows, over the ${opts.maxRows}-row cap. Narrow the ?q= filter and try again.`,
    );
  }

  const handles = listed.map((p) => p.handle);
  // Scoped to `handles`, same as the five aggregates below — an unfiltered
  // cards read here was the one query in this function that ignored
  // opts.handle/opts.q (PR review finding). `handles.length` guard first:
  // MedusaService's `IN ()` on an empty array is the classic footgun, not "no
  // rows" but a query it should never issue.
  const cards = handles.length
    ? await pageAll((page) => packs.listCards({ handle: handles }, page))
    : [];
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));

  // Sequential, NOT Promise.all: each of these checks out its own pool
  // connection (@InjectManager on the three service methods, query.graph for
  // the other two), and five at once is the shape of this repo's "pool is
  // probably full" failures — the same rule inventoryLifecycleBuckets follows
  // internally. This is an admin list; latency is not the constraint.
  const stockByHandle = await getCardStockByHandle(container, handles);
  const skus = await skuByHandle(container, handles);
  const buckets = await packs.inventoryLifecycleBuckets(handles);
  const costByHandle = await packs.weightedAverageCostByHandle(handles);
  const listingCounts = await packs.listingCountByHandle(handles);

  return listed.map((p) => {
    const card = cardByHandle.get(p.handle);
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    // toOptionalMoney, not a bare Number() and not `?? NaN`: a metadata.fmv
    // of null OR '' coerces to 0, and "free" must stay distinguishable from
    // "no FMV recorded". `''` is the case `??` misses (it is not nullish).
    // Same predicate admin/gacha/eligible-products applies to this very field.
    const fmvUsd = card
      ? toMoney(card.market_value)
      : (toOptionalMoney(meta.fmv) ?? NaN);
    const hasFmv = Number.isFinite(fmvUsd);
    // A product with no Card row prices at the DEFAULT_MARKET_MULTIPLIER —
    // the from-PC importer now creates listings at FMV × FX × 1.2 (operator
    // request 2026-08-08), so showing raw FMV here would understate the price
    // the listing actually carries. A Card's own multiplier still wins.
    const mult = card
      ? toMoney(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER)
      : DEFAULT_MARKET_MULTIPLIER;
    const grader =
      card?.grader ?? (typeof meta.grader === 'string' ? meta.grader : '');
    const b = buckets.get(p.handle);
    return {
      handle: p.handle,
      product_id: p.id,
      photo: p.thumbnail ?? null,
      name: card?.name ?? p.title,
      sku: skus.get(p.handle) || p.handle,
      is_card: !!card,
      graded: isGraded({ grader }),
      fmv: hasFmv ? displayMarketPrice(fmvUsd, fx, 1) : null,
      price: hasFmv ? displayMarketPrice(fmvUsd, fx, mult) : null,
      // `??`, never `||`, on BOTH of the next two: 0 and null mean different
      // things. cost 0 = bought and free (unit_cost 0 is legal and
      // weightedAverageCost guards `< 0`, not `<= 0`); cost null = no purchase
      // history. on_hand 0 = tracked with nothing shippable; on_hand null =
      // the product tracks no inventory at all (untracked / infinite).
      // Pinned by inventory-detail.spec.
      cost: costByHandle.get(p.handle) ?? null,
      created_at: p.created_at as string | Date,
      on_hand: stockByHandle.get(p.handle) ?? null,
      in_vault: b?.inVault ?? 0,
      requested: b?.requested ?? 0,
      shipped: b?.shipped ?? 0,
      listing_count: listingCounts.get(p.handle) ?? 0,
    };
  });
}
