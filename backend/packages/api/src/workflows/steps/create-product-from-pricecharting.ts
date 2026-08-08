import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
  ProductStatus,
} from '@medusajs/framework/utils';
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
  deleteProductsWorkflow,
} from '@medusajs/medusa/core-flows';
import {
  buildCardProductInput,
  resolveCardProductContext,
} from '../../modules/packs/card-product';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../modules/packs/pricing';
import {
  ingestPcImage,
  isPcImageUrl,
} from '../../api/admin/media/ingest-pc-image';

// Create a standalone marketplace Product from a PriceCharting lookup. The
// product is now a NORMAL tracked card product (manage_inventory + a stock
// level), identical in shape to a seeded card, so it flows through inventory /
// eligible-products / card registration like any other card. NO gacha Card is
// created here (that is a separate register step).
export type CreateProductFromPcInput = {
  pc_product_id: string;
  pc_grade: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number; // raw USD FMV (PriceCharting per-grade value) — decimal, never cents
  image: string;
  price?: number | null;
  for_sale?: boolean;
  stock?: number; // initial tracked units at the default location (default 0 — counted when in hand)
  // Pixel-Pokémon assignment (Spec 2 §5 id-only) staged on product.metadata as
  // a PixelPokemon library id; the create-card step inherits + mirrors it when
  // the product is later registered as a gacha card.
  pixel_pokemon_id?: string | null;
  // Graded-slab label extras, staged on product.metadata like pixel_pokemon_id;
  // the create-card step inherits them into Card.label_year / label_note.
  label_year?: string | null;
  label_note?: string | null;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Product handle for a PriceCharting import. The grader + grade the operator
 * asserted identify the physical slab, so they key the handle — one product per
 * (card, grade) rather than per card.
 *
 * The tier is the fallback for holdings that assert NEITHER. PriceCharting
 * drops the grading company below its own top-tier price fields, so a "Graded 9"
 * offer arrives grader-less, and §3a forbids inventing one; without the tier,
 * "Ungraded" and "Graded 9" of the same card slug identically and the second
 * create fails on the unique handle/sku index — which is exactly what a bulk
 * collection import does routinely.
 *
 * Ordering note: the tier sits where grader/grade would be, so a handle that
 * HAS a grader is byte-identical to what this produced before the fallback
 * existed. Only previously-impossible (colliding) handles change shape.
 */
export const buildPcProductHandle = (input: {
  name: string;
  grader: string;
  grade: string;
  pc_grade: string;
  pc_product_id: string;
}): string => {
  const asserted = `${input.grader}-${input.grade}`.replace(/-/g, '').trim();
  const key = asserted === '' ? input.pc_grade : `${input.grader}-${input.grade}`;
  return slug(`${input.name}-${key}-${input.pc_product_id}`);
};

// Minimal typed view of the remote-query row (strict mode, no `any`).
type NewProductRow = {
  variants?: Array<{
    inventory_items?: Array<{
      inventory?: { id?: string | null } | null;
    } | null> | null;
  } | null> | null;
};

type CompensateData = { productId: string } | undefined;

export const createProductFromPcInvoke = async (
  input: CreateProductFromPcInput,
  { container }: { container: MedusaContainer },
) => {
  const ctx = await resolveCardProductContext(container);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  // MYR listing price: FMV(USD) × FX × the default +20% margin, unless the
  // caller sent an explicit price. Operator request 2026-08-08: a from-PC
  // listing must carry the same DEFAULT_MARKET_MULTIPLIER a registered card
  // gets, not raw FMV — inventory-view mirrors this for non-card rows.
  const price =
    input.price ??
    displayMarketPrice(
      input.market_value,
      await resolveFxRate(packs),
      DEFAULT_MARKET_MULTIPLIER,
    );

  // A PriceCharting image is never hotlinked: ingest it through the media
  // pipeline (validated + stored on OUR file provider) and persist that URL.
  const image = isPcImageUrl(input.image)
    ? await ingestPcImage(container, input.image)
    : input.image;

  const handle = buildPcProductHandle(input);

  const productInput = buildCardProductInput(
    {
      handle,
      title: input.name,
      image,
      price,
      metadata: {
        fmv: input.market_value,
        points: 0,
        grade: input.grade,
        grader: input.grader,
        set: input.set,
        year: new Date().getFullYear(),
        pc_product_id: input.pc_product_id,
        pc_grade: input.pc_grade,
        // Price provenance: 'manual' marks an operator/API-supplied price so
        // the repricing backfill never overwrites it; absent = derived from
        // FMV (the admin pages never send `price`).
        ...(input.price != null ? { price_source: 'manual' } : {}),
        ...(input.pixel_pokemon_id
          ? { pixel_pokemon_id: input.pixel_pokemon_id }
          : {}),
        ...(input.label_year ? { label_year: input.label_year } : {}),
        ...(input.label_note ? { label_note: input.label_note } : {}),
      },
    },
    {
      shippingProfileId: ctx.shippingProfileId,
      salesChannelId: ctx.salesChannelId,
      status:
        input.for_sale === false
          ? ProductStatus.DRAFT
          : ProductStatus.PUBLISHED,
      manageInventory: true,
    },
  );

  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [productInput],
      additional_data: { seller_id: ctx.sellerId },
    },
  });
  const product = result[0];

  // Single rollback path — delete the just-created product via the delete
  // WORKFLOW (not the module service), so its inventory-item + sales-channel
  // links are cleaned up too; a direct module delete would orphan them.
  // Best-effort: a cleanup failure is logged, never rethrown, so it can never
  // mask the original error thrown at the call site below.
  const rollbackProduct = async () => {
    try {
      await deleteProductsWorkflow(container).run({
        input: { ids: [product.id] },
      });
    } catch (cleanupErr) {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(
          `[from-pricecharting] rollback failed for product ${product.id}: ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
    }
  };

  // createProductsWorkflow auto-creates the inventory ITEM (manage_inventory
  // true); resolve it, then create the LEVEL — the same two-step the seed uses.
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: 'product',
    fields: ['variants.inventory_items.inventory.id'],
    filters: { id: product.id },
  });
  const rows = data as NewProductRow[];
  // A from-PC product is built with exactly ONE canonical variant + inventory item,
  // so [0] is correct by construction; the null-guard below covers "not created".
  const inventoryItemId =
    rows?.[0]?.variants?.[0]?.inventory_items?.[0]?.inventory?.id ?? null;

  if (!inventoryItemId) {
    // No item = we can't stock it; roll back so no orphan product is left.
    await rollbackProduct();
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Inventory item was not created for the new product variant.',
    );
  }

  try {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: [
          {
            location_id: ctx.stockLocationId,
            stocked_quantity: input.stock ?? 0,
            inventory_item_id: inventoryItemId,
          },
        ],
      },
    });
  } catch (e) {
    // Level creation failed after the product exists — delete it so the
    // operator gets a clean retry instead of a tracked-but-unstocked orphan.
    // NOTE: this inline rollback is required — the step's compensate() below
    // only runs when a LATER workflow step fails, not when THIS invoke throws,
    // so it cannot cover an in-invoke failure. Do not remove this in favour of
    // compensate() or the product would be orphaned on level-creation failure.
    await rollbackProduct();
    throw e;
  }

  return new StepResponse(product, {
    productId: product.id,
  } satisfies CompensateData);
};

export const createProductFromPcStep = createStep(
  'create-product-from-pricecharting',
  createProductFromPcInvoke,
  // Fires only if a LATER workflow step fails after this one succeeds.
  async (data: CompensateData, { container }) => {
    if (!data) return;
    await deleteProductsWorkflow(container).run({
      input: { ids: [data.productId] },
    });
  },
);

export default createProductFromPcStep;
