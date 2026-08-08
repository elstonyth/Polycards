/**
 * backfill-pc-listing-prices.ts
 *
 * One-shot backfill for the from-PriceCharting +20% margin fix (2026-08-08):
 * products imported BEFORE the fix were listed at raw FMV × FX (multiplier 1),
 * while imports after it list at FMV × FX × DEFAULT_MARKET_MULTIPLIER (1.2).
 * This recomputes every non-card from-PC listing at the post-fix expression so
 * old and new imports price identically.
 *
 * Scope: products carrying metadata.pc_product_id with NO gacha Card row —
 * once a card is registered, its price is card-managed (Card.market_multiplier)
 * and this script must not touch it.
 *
 * NOTE: recomputes from metadata.fmv at the CURRENT fx rate, so it also
 * overwrites a price an operator set by hand on a from-PC product. Every
 * update is logged old → new for eyeballing.
 *
 * Idempotent: a re-run at the same fx rate finds every row already at target
 * and updates nothing.
 *
 * RUN (backend must be up):
 *   corepack yarn medusa exec ./src/scripts/backfill-pc-listing-prices.ts
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { resolveFxRate } from '../modules/packs/pricing';
import { toOptionalMoney } from '../modules/packs/money';
import { pageAll } from '../api/utils/page-all';
import {
  planPcListingPriceBackfill,
  type PcListingRow,
} from './backfill-pc-listing-prices.helpers';

type VariantPriceRow = {
  id: string;
  variants?: Array<{
    id?: string | null;
    prices?: Array<{
      amount?: unknown;
      currency_code?: string | null;
    } | null> | null;
  } | null> | null;
};

export default async function backfillPcListingPrices({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule = container.resolve(Modules.PRODUCT);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // Whole catalog paged, filtered in JS: listProducts cannot filter on a
  // metadata key, and the catalog is small enough that inventory-view already
  // does exactly this on every admin list load.
  const products = await pageAll((page) =>
    productModule.listProducts({}, page),
  );
  const pcProducts = products.filter(
    (p): p is typeof p & { handle: string } =>
      !!p.handle &&
      typeof (p.metadata ?? {}).pc_product_id === 'string' &&
      ((p.metadata ?? {}).pc_product_id as string) !== '',
  );
  if (pcProducts.length === 0) {
    logger.info('[backfill-pc-listing-prices] No from-PC products found.');
    return;
  }

  // Sequential reads, same pool posture as inventory-view.
  const handles = pcProducts.map((p) => p.handle);
  const cards = await pageAll((page) =>
    packs.listCards({ handle: handles }, page),
  );
  const cardHandles = new Set(cards.map((c) => c.handle));

  const { data } = await query.graph({
    entity: 'product',
    fields: ['id', 'variants.id', 'variants.prices.*'],
    filters: { id: pcProducts.map((p) => p.id) },
  });
  const priceRows = new Map(
    (data as VariantPriceRow[]).map((row) => [row.id, row]),
  );

  const rows: PcListingRow[] = pcProducts.map((p) => {
    const variant = priceRows.get(p.id)?.variants?.[0] ?? null;
    const myr =
      (variant?.prices ?? []).find(
        (pr) => pr?.currency_code?.toLowerCase() === 'myr',
      )?.amount ?? null;
    return {
      product_id: p.id,
      handle: p.handle,
      is_card: cardHandles.has(p.handle),
      fmv_usd: toOptionalMoney((p.metadata ?? {}).fmv),
      variant_id: variant?.id ?? null,
      current_myr: myr === null ? null : Number(myr),
    };
  });

  const fx = await resolveFxRate(packs);
  const plan = planPcListingPriceBackfill(rows, fx);

  logger.info(
    `[backfill-pc-listing-prices] fx=${fx}; ${plan.actions.length} to update, ` +
      `skipped: ${plan.skippedCard} card-managed, ${plan.skippedNoFmv} no FMV, ` +
      `${plan.skippedNoVariant} no variant, ${plan.skippedCurrent} already current.`,
  );

  // Sequential on purpose (pool posture again); each update is one product.
  let updated = 0;
  for (const action of plan.actions) {
    await updateProductsWorkflow(container).run({
      input: {
        products: [
          {
            id: action.product_id,
            variants: [
              {
                id: action.variant_id,
                prices: [{ currency_code: 'myr', amount: action.to }],
              },
            ],
          },
        ],
      },
    });
    updated += 1;
    logger.info(
      `[backfill-pc-listing-prices] ${action.handle}: RM ${action.from ?? '—'} -> RM ${action.to}`,
    );
  }

  logger.info(
    `[backfill-pc-listing-prices] Updated ${updated} listing(s). Done.`,
  );
}
