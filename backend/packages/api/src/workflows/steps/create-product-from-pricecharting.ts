import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import type { MedusaContainer } from "@medusajs/framework/types";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";
import { resolveCardProductContext } from "../../modules/packs/card-product";

// Create a standalone marketplace Product from a PriceCharting lookup. This is
// deliberately catalog-only: NO gacha Card is created (contrast create-card,
// which registers an EXISTING product as a card). The PC link lives on
// product.metadata so a later "promote to card" step can find it.
export type CreateProductFromPcInput = {
  pc_product_id: string;
  pc_grade: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number; // MYR FMV — a decimal, never cents
  image: string;
  price?: number | null;
  for_sale?: boolean;
  market_multiplier?: number;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

type CompensateData = { productId: string } | undefined;

export const createProductFromPcInvoke = async (
  input: CreateProductFromPcInput,
  { container }: { container: MedusaContainer },
) => {
  // Same house-seller / sales-channel / shipping-profile resolution every
  // other catalog-writing path in this repo uses (card-product.ts) — a
  // standalone product still needs these to be a valid Mercur listing.
  const ctx = await resolveCardProductContext(container);
  const price = input.price ?? input.market_value;

  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: input.name,
          handle: slug(`${input.name}-${input.grader}-${input.grade}`),
          status: input.for_sale === false ? "draft" : "published",
          shipping_profile_id: ctx.shippingProfileId,
          thumbnail: input.image,
          images: [{ url: input.image }],
          options: [{ title: "Default", values: ["Default"] }],
          variants: [
            {
              title: "Default",
              options: { Default: "Default" },
              manage_inventory: false,
              prices: [{ currency_code: "myr", amount: price }],
            },
          ],
          sales_channels: [{ id: ctx.salesChannelId }],
          metadata: {
            fmv: input.market_value,
            grade: input.grade,
            grader: input.grader,
            set: input.set,
            pc_product_id: input.pc_product_id,
            pc_grade: input.pc_grade,
            market_multiplier: input.market_multiplier ?? 1.2,
          },
        },
      ],
      additional_data: { seller_id: ctx.sellerId },
    },
  });

  const product = result[0];
  return new StepResponse(product, { productId: product.id } satisfies CompensateData);
};

export const createProductFromPcStep = createStep(
  "create-product-from-pricecharting",
  createProductFromPcInvoke,
);

export default createProductFromPcStep;
