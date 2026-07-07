import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import type { OddsRarity } from '@acme/odds-math';
import {
  deleteSlabFile,
  mirrorSlabToProduct,
} from '../../api/admin/media/bake-slab';

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
        pokemon_dex: number | null;
        sprite_image: string | null;
        pc_product_id: string | null;
        pc_grade: string | null;
        market_multiplier: number;
        pc_synced_at: Date | null;
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

    // A card customers still HOLD cannot be deleted — their vault items would
    // silently vanish (unvaluable, unsellable, invisible). Sell back / deliver /
    // wait first (audit 2026-07-07 #4). bought_back/delivered pulls are history
    // and don't block.
    const [held] = await packs.listPulls(
      { card_id: input.handle, status: ['vaulted', 'delivering'] },
      { take: 1 },
    );
    if (held) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Cannot delete '${input.handle}' — customers still hold copies in their vaults.`,
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
        pokemon_dex: card.pokemon_dex ?? null,
        sprite_image: card.sprite_image ?? null,
        pc_product_id: card.pc_product_id ?? null,
        pc_grade: card.pc_grade ?? null,
        market_multiplier: Number(card.market_multiplier ?? 1.2),
        pc_synced_at: card.pc_synced_at ?? null,
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
    // The kept Product must stop referencing the just-deleted composite too
    // (its metadata.slab_image mirror otherwise points at a 404). NOT
    // compensated on rollback: a restored card's next edit re-mirrors its own
    // slab_image via update-card, so there's nothing to undo here.
    await mirrorSlabToProduct(container, card.handle, null);

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
