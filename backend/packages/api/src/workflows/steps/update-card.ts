import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError, ProductStatus, Modules } from "@medusajs/framework/utils";
import {
  createProductsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";
import {
  buildCardProductInput,
  resolveCardProductContext,
} from "../../modules/packs/card-product";
import type { CardWriteInput, Rarity } from "./create-card";

// Everything about a card is editable EXCEPT its handle (the immutable key that
// PackOdds / Pull / the Product reference). `handle` selects the row to patch.
export type UpdateCardInput = CardWriteInput;

type CardSnapshot = {
  id: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  rarity: Rarity;
  market_value: number;
  image: string;
  price: number | null;
  for_sale: boolean;
};

type ProductSnapshot = {
  id: string;
  title: string;
  status: string;
  thumbnail: string | null;
  images: { url: string }[];
  metadata: Record<string, unknown>;
  variantId: string | null;
};

type CompensateData =
  | { card: CardSnapshot; product: ProductSnapshot | null }
  | undefined;

// update-card — patch the Card row and bring its mirrored Product back in sync:
// update title/image/metadata/price and flip PUBLISHED<->DRAFT to match for_sale.
// Upsert: if the Product is somehow missing it is (re)created. Compensation
// restores the prior Card AND the full prior Product state.
export const updateCardStep = createStep(
  "update-card",
  async (input: UpdateCardInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const productModule = container.resolve(Modules.PRODUCT);

    const [card] = await packs.listCards({ handle: input.handle }, { take: 1 });
    if (!card) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Card '${input.handle}' not found.`
      );
    }

    const snapshot: CardSnapshot = {
      id: card.id,
      name: card.name,
      set: card.set,
      grader: card.grader,
      grade: card.grade,
      rarity: card.rarity,
      market_value: Number(card.market_value),
      image: card.image,
      price: card.price === null ? null : Number(card.price),
      for_sale: card.for_sale,
    };

    const salePrice = input.price ?? input.market_value;

    await packs.updateCards([
      {
        id: card.id,
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

    // Mirror to the Product (handle === card.handle).
    const [product] = await productModule.listProducts(
      { handle: input.handle },
      { take: 1, relations: ["variants", "images"] }
    );
    const nextStatus = input.for_sale
      ? ProductStatus.PUBLISHED
      : ProductStatus.DRAFT;

    if (product) {
      const variantId = product.variants?.[0]?.id ?? null;
      // Capture the full prior Product state so compensation restores everything,
      // not just status. The prior variant price isn't loaded here (it lives in a
      // price set); compensation restores it from the Card snapshot, since
      // Card.price and the Product variant price are kept in sync.
      const prevProduct: ProductSnapshot = {
        id: product.id,
        title: product.title,
        status: product.status,
        thumbnail: product.thumbnail ?? null,
        images: (product.images ?? []).map((im) => ({ url: im.url })),
        metadata: (product.metadata ?? {}) as Record<string, unknown>,
        variantId,
      };
      await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: product.id,
              title: input.name,
              status: nextStatus,
              thumbnail: input.image,
              images: [{ url: input.image }],
              metadata: {
                ...(product.metadata ?? {}),
                fmv: input.market_value,
                grade: input.grade,
                grader: input.grader,
                set: input.set,
                rarity: input.rarity,
              },
              ...(variantId
                ? {
                    variants: [
                      {
                        id: variantId,
                        prices: [{ currency_code: "usd", amount: salePrice }],
                      },
                    ],
                  }
                : {}),
            },
          ],
        },
      });
      return new StepResponse(
        { handle: card.handle, productId: product.id },
        { card: snapshot, product: prevProduct } satisfies CompensateData
      );
    }

    // Defensive upsert: no Product for this handle — create one to match.
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
        status: nextStatus,
        manageInventory: false,
      }
    );
    const { result } = await createProductsWorkflow(container).run({
      input: {
        products: [productInput],
        additional_data: { seller_id: ctx.sellerId },
      },
    });

    return new StepResponse(
      { handle: card.handle, productId: result[0].id },
      { card: snapshot, product: null } satisfies CompensateData
    );
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updateCards([
      {
        id: data.card.id,
        name: data.card.name,
        set: data.card.set,
        grader: data.card.grader,
        grade: data.card.grade,
        rarity: data.card.rarity,
        market_value: data.card.market_value,
        image: data.card.image,
        price: data.card.price,
        for_sale: data.card.for_sale,
      },
    ]);
    if (data.product) {
      const p = data.product;
      await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: p.id,
              title: p.title,
              status: p.status as ProductStatus,
              thumbnail: p.thumbnail ?? undefined,
              images: p.images,
              metadata: p.metadata,
              ...(p.variantId
                ? {
                    variants: [
                      {
                        id: p.variantId,
                        prices: [
                          {
                            currency_code: "usd",
                            amount: data.card.price ?? data.card.market_value,
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            },
          ],
        },
      });
    }
  }
);

export default updateCardStep;
