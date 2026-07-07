import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type DeletePackInput = { slug: string };

// Snapshots ALL of a pack's odds rows for compensation, including reward rows
// (card_id null) — keep card_id/rarity nullable and carry the full payout shape
// (kind/product_handle/credit_amount) so a deleted reward_box pool round-trips
// faithfully instead of losing its prize definitions on rollback.
type OddsSnapshot = {
  pack_id: string;
  card_id: string | null;
  rarity:
    | 'Immortal'
    | 'Legendary'
    | 'Mythical'
    | 'Rare'
    | 'Uncommon'
    | 'Common'
    | null;
  weight: number;
  locked: boolean;
  kind: 'product' | 'credit' | 'nothing' | null;
  product_handle: string | null;
  credit_amount: number | null;
};

type CompensateData =
  | {
      pack: {
        slug: string;
        title: string;
        category: string;
        price: number;
        image: string;
        boost: boolean;
        rank: number;
        status: 'active' | 'draft';
        // reward_box packs carry pool config — restore it too.
        pool_enabled: boolean;
        draws_per_day: number;
        buyback_percent: number;
        in_stock: boolean;
        published_odds: Record<string, unknown> | null;
      };
      odds: OddsSnapshot[];
    }
  | undefined;

// delete-pack — remove a pack and its PackOdds (prize-pool membership). Cards and
// Pull history are kept (cards live independently; the ledger is permanent).
// Compensation recreates the pack and its odds rows.
export const deletePackStep = createStep(
  'delete-pack',
  async (input: DeletePackInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [pack] = await packs.listPacks({ slug: input.slug }, { take: 1 });
    if (!pack) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pack '${input.slug}' not found.`,
      );
    }

    const oddsRows = await packs.listPackOdds(
      { pack_id: input.slug },
      { take: 1000 },
    );

    const snapshot: CompensateData = {
      pack: {
        slug: pack.slug,
        title: pack.title,
        category: pack.category,
        price: pack.price,
        image: pack.image,
        boost: pack.boost,
        rank: pack.rank,
        status: pack.status,
        pool_enabled: pack.pool_enabled,
        draws_per_day: pack.draws_per_day,
        buyback_percent: pack.buyback_percent,
        in_stock: pack.in_stock,
        published_odds:
          (pack.published_odds as Record<string, unknown> | null) ?? null,
      },
      odds: oddsRows.map((o) => ({
        pack_id: o.pack_id,
        card_id: o.card_id,
        rarity: o.rarity,
        weight: o.weight,
        locked: o.locked,
        kind: o.kind,
        product_handle: o.product_handle,
        credit_amount: o.credit_amount != null ? Number(o.credit_amount) : null,
      })),
    };

    if (oddsRows.length) {
      await packs.deletePackOdds(oddsRows.map((o) => o.id));
    }
    await packs.deletePacks([pack.id]);

    return new StepResponse({ slug: input.slug }, snapshot);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.createPacks([data.pack]);
    if (data.odds.length) {
      await packs.createPackOdds(data.odds);
    }
  },
);

export default deletePackStep;
