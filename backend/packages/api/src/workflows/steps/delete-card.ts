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
import type { Rarity } from "./create-card";

export type DeleteCardInput = { handle: string };

type OddsSnapshot = {
  pack_id: string;
  card_id: string;
  weight: number;
  locked: boolean;
};

type CompensateData =
  | {
      card: {
        handle: string;
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
      odds: OddsSnapshot[];
    }
  | undefined;

// delete-card — remove a card everywhere it is the catalog definition: its
// PackOdds membership rows (so no pack rolls a now-missing card) AND its mirrored
// marketplace Product. Pull history is intentionally KEPT — the ledger is a
// permanent record; a deleted card simply shows as unknown there. Compensation
// recreates the card, its odds rows, and the Product mirror.
export const deleteCardStep = createStep(
  "delete-card",
  async (input: DeleteCardInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const productModule = container.resolve(Modules.PRODUCT);

    const [card] = await packs.listCards({ handle: input.handle }, { take: 1 });
    if (!card) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Card '${input.handle}' not found.`
      );
    }

    const oddsRows = await packs.listPackOdds(
      { card_id: input.handle },
      { take: 1000 }
    );
    const oddsSnapshot: OddsSnapshot[] = oddsRows.map((o) => ({
      pack_id: o.pack_id,
      card_id: o.card_id,
      weight: o.weight,
      locked: o.locked,
    }));

    const snapshot: CompensateData = {
      card: {
        handle: card.handle,
        name: card.name,
        set: card.set,
        grader: card.grader,
        grade: card.grade,
        rarity: card.rarity,
        market_value: Number(card.market_value),
        image: card.image,
        price: card.price === null ? null : Number(card.price),
        for_sale: card.for_sale,
      },
      odds: oddsSnapshot,
    };

    if (oddsRows.length) {
      await packs.deletePackOdds(oddsRows.map((o) => o.id));
    }
    await packs.deleteCards([card.id]);

    const [product] = await productModule.listProducts(
      { handle: input.handle },
      { take: 1 }
    );
    if (product) {
      await deleteProductsWorkflow(container).run({
        input: { ids: [product.id] },
      });
    }

    return new StepResponse({ handle: input.handle }, snapshot);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    await packs.createCards([data.card]);
    if (data.odds.length) {
      await packs.createPackOdds(data.odds);
    }

    const ctx = await resolveCardProductContext(container);
    const productInput = buildCardProductInput(
      {
        handle: data.card.handle,
        title: data.card.name,
        image: data.card.image,
        price: data.card.price ?? data.card.market_value,
        metadata: {
          fmv: data.card.market_value,
          points: 0,
          grade: data.card.grade,
          grader: data.card.grader,
          set: data.card.set,
          rarity: data.card.rarity,
          year: new Date().getFullYear(),
        },
      },
      {
        shippingProfileId: ctx.shippingProfileId,
        salesChannelId: ctx.salesChannelId,
        status: data.card.for_sale
          ? ProductStatus.PUBLISHED
          : ProductStatus.DRAFT,
        manageInventory: false,
      }
    );
    await createProductsWorkflow(container).run({
      input: {
        products: [productInput],
        additional_data: { seller_id: ctx.sellerId },
      },
    });
  }
);

export default deleteCardStep;
