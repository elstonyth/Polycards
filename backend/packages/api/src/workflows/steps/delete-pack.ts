import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { pageAll } from '../../api/utils/page-all';
import {
  configAuditRow,
  oddsSnapshot,
  packConfig,
} from '../../modules/packs/config-audit';

// admin_id is the acting admin (auth_context.actor_id) for the audit row.
export type DeletePackInput = { slug: string; admin_id: string };

// Snapshots ALL of a pack's odds rows for compensation, including reward rows
// (card_id null) — keep card_id/rarity nullable and carry the full payout shape
// (kind/product_handle/credit_amount) so a deleted reward_box pool round-trips
// faithfully instead of losing its prize definitions on rollback. weight_2 /
// weight_3 / top_hit_order ride along too: a restore without them silently
// dropped the pack's set-2/3 odds tables and its Top Hits.
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
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
  top_hit_order: number | null;
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
        // Compensation is an INSERT (no json-merge hazard), so the raw stored
        // shapes round-trip as-is — but they must be CARRIED or a rolled-back
        // delete silently reverts the pack to inherit-global tiers, no hero
        // art, and the default RTP target.
        display_image: string | null;
        target_rtp_bps: number;
        tier_ranges: Record<string, unknown> | null;
      };
      odds: OddsSnapshot[];
    }
  | undefined;

// delete-pack — remove a pack and its PackOdds (prize-pool membership). Cards and
// Pull history are kept (cards live independently; the ledger is permanent).
// Compensation recreates the pack and its odds rows. The output carries the
// audit row (the pack and its whole odds table as they stood) for the
// workflow's final record-admin-audit step.
export const deletePackInvoke = async (
  input: DeletePackInput,
  { container }: { container: MedusaContainer },
) => {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const [pack] = await packs.listPacks({ slug: input.slug }, { take: 1 });
  if (!pack) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pack '${input.slug}' not found.`,
    );
  }

  // PAGED — a bare take:1000 would delete (and snapshot for compensation)
  // only the first 1,000 rows of a larger pool.
  const oddsRows = await pageAll((opts) =>
    packs.listPackOdds({ pack_id: input.slug }, opts),
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
      display_image: pack.display_image ?? null,
      target_rtp_bps: pack.target_rtp_bps ?? 7000,
      tier_ranges: (pack.tier_ranges as Record<string, unknown> | null) ?? null,
    },
    odds: oddsRows.map((o) => ({
      pack_id: o.pack_id,
      card_id: o.card_id,
      rarity: o.rarity,
      weight: o.weight,
      weight_2: o.weight_2 ?? null,
      weight_3: o.weight_3 ?? null,
      locked: o.locked,
      top_hit_order: o.top_hit_order ?? null,
      kind: o.kind,
      product_handle: o.product_handle,
      credit_amount: o.credit_amount != null ? Number(o.credit_amount) : null,
    })),
  };

  if (oddsRows.length) {
    await packs.deletePackOdds(oddsRows.map((o) => o.id));
  }
  await packs.deletePacks([pack.id]);

  const audit = configAuditRow({
    adminId: input.admin_id,
    entityType: 'pack',
    entityId: pack.slug,
    action: 'delete',
    before: { pack: packConfig(pack), ...oddsSnapshot(oddsRows) },
    after: null,
  });

  return new StepResponse({ slug: input.slug, audit }, snapshot);
};

export const deletePackStep = createStep(
  'delete-pack',
  deletePackInvoke,
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
