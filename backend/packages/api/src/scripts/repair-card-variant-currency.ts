/**
 * repair-card-variant-currency.ts
 *
 * One-shot repair for the card-edit currency flip (found in the PR #397
 * review): update-card.ts used to mirror the variant price as
 * `currency_code: 'usd'`, and Medusa's updatePriceSets replaces the whole
 * price set — so every card edited through the admin lost its myr price and
 * ended up usd-only, in a store whose single region (Malaysia) sells in MYR.
 *
 * Scope: products WITH a gacha Card row whose variant carries NO myr price.
 * Each gets the exact amount the fixed edit path writes — Card.price (MYR),
 * or the FMV-derived display price (FMV × fx × the card's multiplier). The
 * replace-the-set semantics that caused the corruption also clean it up: the
 * single myr row replaces the stray usd row.
 *
 * Idempotent: repaired variants have a myr price and are skipped on re-run.
 *
 * RUN (local, DB reachable):
 *   corepack yarn medusa exec ./src/scripts/repair-card-variant-currency.ts
 *
 * PROD: run via scripts/do-exec.mjs (the DO app console websocket — a piped
 * `doctl apps console` has no TTY), and on the API component, not the worker:
 * the basic-xxs worker OOMs on `medusa exec`.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  DEFAULT_MARKET_MULTIPLIER,
  resolveFxRateStrict,
} from '../modules/packs/pricing';
import { toMoney, toOptionalMoney } from '../modules/packs/money';
import { pageAll } from '../api/utils/page-all';
import {
  planCardVariantCurrencyRepair,
  type CardVariantRow,
} from './repair-card-variant-currency.helpers';

type VariantPriceRow = {
  id: string;
  handle: string | null;
  variants?: Array<{
    id?: string | null;
    prices?: Array<{
      amount?: unknown;
      currency_code?: string | null;
    } | null> | null;
  } | null> | null;
};

export default async function repairCardVariantCurrency({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const cards = await pageAll((page) => packs.listCards({}, page));
  if (cards.length === 0) {
    logger.info('[repair-card-variant-currency] No cards registered.');
    return;
  }
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));

  // One graph read for every card product's variant + price rows. Filtered by
  // handle (the Card↔Product key), not a metadata field, so it stays a real
  // DB-side filter.
  const { data } = await query.graph({
    entity: 'product',
    fields: ['id', 'handle', 'variants.id', 'variants.prices.*'],
    filters: { handle: cards.map((c) => c.handle) },
  });

  // STRICT resolver — mass money-write posture, same as
  // backfill-pc-listing-prices: refuse an unfirm FX quote rather than
  // repricing the catalog at the hardcoded fallback.
  const fx = await resolveFxRateStrict(packs);

  const rows: CardVariantRow[] = (data as VariantPriceRow[])
    .filter((p): p is VariantPriceRow & { handle: string } => !!p.handle)
    .map((p) => {
      const card = cardByHandle.get(p.handle)!;
      const variant = p.variants?.[0] ?? null;
      const hasMyr = (variant?.prices ?? []).some(
        (pr) => pr?.currency_code?.toLowerCase() === 'myr',
      );
      return {
        product_id: p.id,
        handle: p.handle,
        variant_id: variant?.id ?? null,
        has_myr: hasMyr,
        card_price_myr: toOptionalMoney(card.price),
        market_value_usd: toMoney(card.market_value),
        market_multiplier: toMoney(
          card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
        ),
      };
    });

  const plan = planCardVariantCurrencyRepair(rows, fx);
  logger.info(
    `[repair-card-variant-currency] fx=${fx}; ${plan.actions.length} usd-only ` +
      `variant(s) to repair, skipped: ${plan.skippedHealthy} healthy, ` +
      `${plan.skippedNoVariant} no variant.`,
  );

  // Sequential on purpose (pool posture); each update is one product.
  //
  // TOCTOU guard (PR #398 review): the plan is built from a snapshot, and a
  // concurrent card edit (now fixed to write myr) could land between the
  // snapshot and this loop — replacing its fresh price with the stale planned
  // amount. Re-read the variant right before writing and skip if a myr row
  // has appeared. A shared write lock would close the residual ~ms window,
  // but this is a one-shot operator script; the recheck keeps it dependency-
  // free and the skip is counted, not silent.
  let repaired = 0;
  let skippedRace = 0;
  for (const action of plan.actions) {
    const { data: fresh } = await query.graph({
      entity: 'product',
      fields: ['variants.prices.currency_code'],
      filters: { id: action.product_id },
    });
    const freshPrices =
      (fresh[0] as VariantPriceRow | undefined)?.variants?.[0]?.prices ?? [];
    if (
      freshPrices.some((p) => p?.currency_code?.toLowerCase() === 'myr')
    ) {
      skippedRace += 1;
      logger.info(
        `[repair-card-variant-currency] ${action.handle}: myr appeared since the snapshot (concurrent edit) — skipped.`,
      );
      continue;
    }
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
    repaired += 1;
    logger.info(
      `[repair-card-variant-currency] ${action.handle}: myr restored at RM ${action.to}`,
    );
  }

  logger.info(
    `[repair-card-variant-currency] Repaired ${repaired} variant(s)` +
      (skippedRace > 0 ? `, ${skippedRace} skipped to a concurrent edit` : '') +
      `. Done.`,
  );
}
