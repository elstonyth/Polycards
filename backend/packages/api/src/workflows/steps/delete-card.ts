import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import type { OddsRarity } from '@acme/odds-math';
import { deleteSlabFile } from '../../api/admin/media/bake-slab';

export type DeleteCardInput = { handle: string };

type OddsSnapshot = {
  pack_id: string;
  card_id: string;
  rarity: OddsRarity;
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
        market_value: number;
        image: string;
        price: number | null;
        for_sale: boolean;
        slab_image: string | null;
        slab_image_key: string | null;
      };
      odds: OddsSnapshot[];
    }
  | undefined;

// delete-card — UNREGISTER a card from the gacha system: remove the Card row and
// its PackOdds membership rows (so no pack rolls a now-missing card). The
// inventory Product is deliberately KEPT — the item returns to being a plain
// catalog product (inventory-first model); delete it in the product catalog if
// you really want it gone. Pull history is also kept — the ledger is a permanent
// record. Compensation recreates the card and its odds rows.
export const deleteCardStep = createStep(
  'delete-card',
  async (input: DeleteCardInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [card] = await packs.listCards({ handle: input.handle }, { take: 1 });
    if (!card) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Card '${input.handle}' not found.`,
      );
    }

    const oddsRows = await packs.listPackOdds(
      { card_id: input.handle },
      { take: 1000 },
    );
    // Queried by a single card handle, so every row is a card row: card_id and
    // rarity are non-null by that invariant (reward rows have card_id null).
    const oddsSnapshot: OddsSnapshot[] = oddsRows.map((o) => ({
      pack_id: o.pack_id,
      card_id: o.card_id!,
      rarity: o.rarity!,
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
        market_value: Number(card.market_value),
        image: card.image,
        price: card.price === null ? null : Number(card.price),
        for_sale: card.for_sale,
        slab_image: card.slab_image ?? null,
        slab_image_key: card.slab_image_key ?? null,
      },
      odds: oddsSnapshot,
    };

    if (oddsRows.length) {
      await packs.deletePackOdds(oddsRows.map((o) => o.id));
    }
    await packs.deleteCards([card.id]);

    // The card's baked composite goes with it (decision #8; best-effort). A
    // compensated delete restores the row pointing at a deleted file — the
    // storefront then shows the bare photo until the next save re-bakes.
    await deleteSlabFile(container, card.slab_image_key ?? null);

    return new StepResponse({ handle: input.handle }, snapshot);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    await packs.createCards([data.card]);
    if (data.odds.length) {
      await packs.createPackOdds(data.odds);
    }
  },
);

export default deleteCardStep;
