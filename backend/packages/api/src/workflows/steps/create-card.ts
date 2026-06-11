import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils";
import { MercurModules } from "@mercurjs/types";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";

// Inventory-first registration: the PRODUCT is the item, created in the product
// catalog beforehand. Registering it as a gacha Card only records the gacha
// facts (FMV, set, grader, grade) — name/image/handle are READ from the product,
// never entered twice. Rarity is NOT set here: it is chosen per pack when the
// card joins a prize pool (PackOdds.rarity).
export type RegisterCardInput = {
  product_id: string;
  set: string;
  grader: string;
  grade: string;
  market_value: number; // USD FMV — a decimal, never cents
};

type CompensateData =
  | {
      cardId: string;
      productId: string;
      prevMetadata: Record<string, unknown>;
    }
  | undefined;

// create-card — register an existing catalog Product as a gacha Card. Creates
// ONLY the Card row (handle === Product.handle, the shared business key) and
// mirrors the gacha facts onto the product's metadata so the marketplace detail
// page can show FMV/grade. The product itself is never created or deleted here.
//
// The invoke handler is a named export so the unit suite can drive it with a
// stubbed container: the duplicate-registration RACE branch (pre-check passes,
// then the handle's UNIQUE constraint throws) cannot be triggered
// deterministically through the HTTP harness.
export const registerCardInvoke = async (
  input: RegisterCardInput,
  { container }: { container: MedusaContainer }
) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const productModule = container.resolve(Modules.PRODUCT);

    const [product] = await productModule.listProducts(
      { id: input.product_id },
      { take: 1, relations: ["images"] }
    );
    if (!product) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Product '${input.product_id}' not found — add the item to the inventory first.`
      );
    }
    if (!product.handle) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Product '${input.product_id}' has no handle.`
      );
    }

    const image = product.thumbnail ?? product.images?.[0]?.url ?? "";
    if (!image) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Product '${product.title}' has no image — upload one on the product before registering it as a card.`
      );
    }

    // Handle is the unique business key shared by Card + Product + PackOdds.
    const [existingCard] = await packs.listCards(
      { handle: product.handle },
      { take: 1 }
    );
    if (existingCard) {
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `'${product.title}' is already registered as a gacha card.`
      );
    }

    // The pre-check above is advisory only — two concurrent registrations of
    // the same product both pass it. The handle's UNIQUE constraint is the
    // real guard; map its violation to the same friendly duplicate error
    // instead of letting a raw DB error surface as a 500 (mirror of the
    // credit-row pattern in buyback-pull).
    let card: Awaited<ReturnType<typeof packs.createCards>>[number];
    try {
      [card] = await packs.createCards([
        {
          handle: product.handle,
          name: product.title,
          set: input.set,
          grader: input.grader,
          grade: input.grade,
          market_value: input.market_value,
          image,
          // NULL price = "use FMV"; the product's own variant price stays the
          // marketplace source of truth and is not touched by registration.
          price: null,
          for_sale: product.status === "published",
        },
      ]);
    } catch (error) {
      // The recovery probe gets its own guard: if the insert failed because
      // the DB is down, this re-list fails too, and ITS error must never
      // replace the original fault.
      let raced: unknown;
      try {
        [raced] = await packs.listCards(
          { handle: product.handle },
          { take: 1 }
        );
      } catch {
        raced = undefined;
      }
      if (raced) {
        throw new MedusaError(
          MedusaError.Types.DUPLICATE_ERROR,
          `'${product.title}' is already registered as a gacha card.`
        );
      }
      throw error;
    }

    // Mirror the gacha facts onto the product metadata (the marketplace card
    // page reads fmv/grade/grader/set from there) and make sure the product is
    // LINKED to the house seller — Mercur's storefront product middleware hides
    // seller-less products, so a hand-created catalog product would otherwise
    // never show on /marketplace even when published. If any of this fails,
    // undo the Card so the step is atomic (StepResponse compensation only
    // covers later steps). The seller link is intentionally NOT compensated:
    // every catalog product belongs to the house seller in this single-vendor
    // store, so a kept link is the desired end state regardless.
    const prevMetadata = (product.metadata ?? {}) as Record<string, unknown>;
    try {
      const query = container.resolve(ContainerRegistrationKeys.QUERY);
      const { data: withSeller } = await query.graph({
        entity: "product",
        fields: ["id", "seller.id"],
        filters: { id: product.id },
      });
      if (!withSeller[0]?.seller?.id) {
        const sellerService = container.resolve(MercurModules.SELLER);
        const [houseSeller] = await sellerService.listSellers({
          handle: "house",
        });
        if (!houseSeller) {
          throw new MedusaError(
            MedusaError.Types.NOT_FOUND,
            "House seller not found — run the seed before managing the catalog."
          );
        }
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { product_id: product.id },
          [MercurModules.SELLER]: { seller_id: houseSeller.id },
        });
      }
      await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: product.id,
              metadata: {
                ...prevMetadata,
                fmv: input.market_value,
                points: typeof prevMetadata.points === "number" ? prevMetadata.points : 0,
                grade: input.grade,
                grader: input.grader,
                set: input.set,
                year:
                  typeof prevMetadata.year === "number"
                    ? prevMetadata.year
                    : new Date().getFullYear(),
              },
            },
          ],
        },
      });
    } catch (error) {
      await packs.deleteCards([card.id]);
      throw error;
    }

    return new StepResponse(
      { handle: card.handle, productId: product.id },
      { cardId: card.id, productId: product.id, prevMetadata } satisfies CompensateData
    );
};

export const createCardStep = createStep(
  "create-card",
  registerCardInvoke,
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCards([data.cardId]);
    await updateProductsWorkflow(container).run({
      input: {
        products: [{ id: data.productId, metadata: data.prevMetadata }],
      },
    });
  }
);

export default createCardStep;
