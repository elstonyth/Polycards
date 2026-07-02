import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows";
import {
  buildCardProductInput,
  resolveCardProductContext,
} from "../../modules/packs/card-product";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";
import { displayMarketPrice, resolveFxRate } from "../../modules/packs/pricing";

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
  market_multiplier?: number;
  stock?: number; // initial tracked units at the default location (default 1)
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

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
  const multiplier = input.market_multiplier ?? 1.2;
  // MYR listing price: FMV(USD) x FX x markup, unless the caller sent one.
  const price =
    input.price ??
    displayMarketPrice(input.market_value, await resolveFxRate(packs), multiplier);

  const handle = slug(
    `${input.name}-${input.grader}-${input.grade}-${input.pc_product_id}`,
  );

  const productInput = buildCardProductInput(
    {
      handle,
      title: input.name,
      image: input.image,
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
        market_multiplier: multiplier,
      },
    },
    {
      shippingProfileId: ctx.shippingProfileId,
      salesChannelId: ctx.salesChannelId,
      status:
        input.for_sale === false ? ProductStatus.DRAFT : ProductStatus.PUBLISHED,
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

  // createProductsWorkflow auto-creates the inventory ITEM (manage_inventory
  // true); resolve it, then create the LEVEL — the same two-step the seed uses.
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product",
    fields: ["variants.inventory_items.inventory.id"],
    filters: { id: product.id },
  });
  const rows = data as NewProductRow[];
  const inventoryItemId =
    rows?.[0]?.variants?.[0]?.inventory_items?.[0]?.inventory?.id ?? null;

  if (!inventoryItemId) {
    // No item = we can't stock it; roll back so no orphan product is left.
    await container.resolve(Modules.PRODUCT).deleteProducts([product.id]);
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Inventory item was not created for the new product variant.",
    );
  }

  try {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: [
          {
            location_id: ctx.stockLocationId,
            stocked_quantity: input.stock ?? 1,
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
    await container.resolve(Modules.PRODUCT).deleteProducts([product.id]);
    throw e;
  }

  return new StepResponse(
    product,
    { productId: product.id } satisfies CompensateData,
  );
};

export const createProductFromPcStep = createStep(
  "create-product-from-pricecharting",
  createProductFromPcInvoke,
  // Fires only if a LATER workflow step fails after this one succeeds.
  async (data: CompensateData, { container }) => {
    if (!data) return;
    await container.resolve(Modules.PRODUCT).deleteProducts([data.productId]);
  },
);

export default createProductFromPcStep;
