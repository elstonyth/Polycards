import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError, ProductStatus, Modules } from "@medusajs/framework/utils";
import {
  createProductsWorkflow,
  deleteProductsWorkflow,
} from "@medusajs/medusa/core-flows";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";
import {
  buildCardProductInput,
  resolveCardProductContext,
} from "../../modules/packs/card-product";

export type Rarity = "Legendary" | "Epic" | "Rare" | "Uncommon" | "Common";

export type CardWriteInput = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  rarity: Rarity;
  market_value: number;
  image: string;
  // Standalone sale price. Falls back to market_value (FMV) when omitted.
  price?: number;
  // Listed on the marketplace (mirrored Product PUBLISHED) vs pack-only (DRAFT).
  for_sale: boolean;
};

type CompensateData = { cardId: string; productId: string } | undefined;

// create-card — create the gacha Card row AND its mirrored marketplace Product
// (handle === Card.handle) in one compensated step. The Product is ALWAYS created
// (PUBLISHED when for_sale, else DRAFT) so the later edit/toggle flow only ever
// flips status — never create/delete churn. Compensation removes both.
export const createCardStep = createStep(
  "create-card",
  async (input: CardWriteInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const productModule = container.resolve(Modules.PRODUCT);

    // Handle is the unique business key shared by Card + Product + PackOdds.
    const [existingCard] = await packs.listCards(
      { handle: input.handle },
      { take: 1 }
    );
    if (existingCard) {
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `A card with handle '${input.handle}' already exists.`
      );
    }
    const existingProducts = await productModule.listProducts(
      { handle: input.handle },
      { take: 1 }
    );
    if (existingProducts.length) {
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `A product with handle '${input.handle}' already exists.`
      );
    }

    const salePrice = input.price ?? input.market_value;

    const [card] = await packs.createCards([
      {
        handle: input.handle,
        name: input.name,
        set: input.set,
        grader: input.grader,
        grade: input.grade,
        rarity: input.rarity,
        market_value: input.market_value,
        image: input.image,
        // Store the operator's price verbatim — NULL means "use FMV" and must be
        // preserved (the Product mirror below still gets a concrete `salePrice`).
        price: input.price ?? null,
        for_sale: input.for_sale,
      },
    ]);

    // Mirror the Product. If this fails, undo the Card we just created so the step
    // is atomic (StepResponse compensation only covers later-step failures).
    let productId: string;
    try {
      const ctx = await resolveCardProductContext(container);
      const productInput = buildCardProductInput(
        {
          handle: input.handle,
          title: input.name,
          image: input.image,
          price: salePrice,
          metadata: {
            fmv: input.market_value,
            points: 0,
            grade: input.grade,
            grader: input.grader,
            set: input.set,
            rarity: input.rarity,
            year: new Date().getFullYear(),
          },
        },
        {
          shippingProfileId: ctx.shippingProfileId,
          salesChannelId: ctx.salesChannelId,
          status: input.for_sale ? ProductStatus.PUBLISHED : ProductStatus.DRAFT,
          manageInventory: false,
        }
      );

      const { result } = await createProductsWorkflow(container).run({
        input: {
          products: [productInput],
          additional_data: { seller_id: ctx.sellerId },
        },
      });
      productId = result[0].id;
    } catch (error) {
      await packs.deleteCards([card.id]);
      throw error;
    }

    return new StepResponse(
      { handle: card.handle, productId },
      { cardId: card.id, productId } satisfies CompensateData
    );
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await deleteProductsWorkflow(container).run({ input: { ids: [data.productId] } });
    await packs.deleteCards([data.cardId]);
  }
);

export default createCardStep;
