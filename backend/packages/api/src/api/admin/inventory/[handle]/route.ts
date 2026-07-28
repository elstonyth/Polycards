import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { loadInventoryRows } from '../../../../modules/packs/inventory-view';
import type { ChallengeRankReward } from '../../../../modules/packs/challenge-validate';
import { parsePaginationParams } from '../../../../utils/pagination';
import { pageAll } from '../../../utils/page-all';

// GET /admin/inventory/:handle -- one Inventory item: the same row the list
// renders, plus where the card is listed (pack pools, weekly-challenge rank
// rewards) and its stock-movement history (POLYCARD-BACK section 3.4).
// Admin-only by inheritance: no middlewares.ts matcher claims this path, so it
// takes Medusa's default /admin/* auth.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const handle = req.params.handle;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Parsed BEFORE any DB work, so a malformed ?limit 400s without paying for
  // the catalog read.
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );

  // Scoped by handle, then re-checked in memory: the scope is what keeps this
  // route from computing five aggregates over the whole catalog, the .find()
  // is what makes "which row" exact. Deliberately NOT `{ q: handle }` -- see
  // loadInventoryRows: `handle` is not a searchable Product field, so `q`
  // would miss the very row being asked for.
  const rows = await loadInventoryRows(req.scope, { handle });
  const item = rows.find((r) => r.handle === handle);
  if (!item) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Inventory item '${handle}' not found.`,
    );
  }

  // Sequential, NOT Promise.all -- same pool rule loadInventoryRows follows
  // internally. This is an admin detail page; latency is not the constraint.
  //
  // `card_id: handle` is already what excludes reward-pool entries: the
  // pack_odds_kind_payout_check CHECK makes `kind IS NOT NULL` imply
  // `card_id IS NULL`, so a prize row can never carry a handle. `kind: null`
  // is therefore REDUNDANT here and kept only so this filter is byte-identical
  // to listingCountByHandle's -- the list's `listing_count` and this page's
  // association list must never be able to drift apart. PAGED,
  // never `take: N`: a truncated association list reads as "this card is in
  // fewer packs than it is" -- a plausible wrong answer, not an obvious error.
  const oddsRows = await pageAll((page) =>
    packs.listPackOdds({ card_id: handle, kind: null }, page),
  );
  const packSlugs = [...new Set(oddsRows.map((o) => o.pack_id))];
  const packRows = packSlugs.length
    ? await pageAll((page) => packs.listPacks({ slug: packSlugs }, page))
    : [];
  const titleBySlug = new Map(packRows.map((p) => [p.slug, p.title]));

  const stages = await pageAll((page) => packs.listChallengeStages({}, page));
  const rankRewards: { stage_number: number; rank: number }[] = [];
  for (const stage of stages) {
    const rewards =
      (stage.rank_rewards as unknown as ChallengeRankReward[]) ?? [];
    for (const r of rewards) {
      if (r.card_id === handle) {
        rankRewards.push({ stage_number: stage.stage_number, rank: r.rank });
      }
    }
  }

  // `id` as the secondary sort is NOT a chronology claim (created_at is the
  // only truth about order here) -- it makes the sort TOTAL, which is what
  // OFFSET pagination needs: without a tiebreaker, rows sharing a timestamp
  // can come back on two pages or on none. Same rule pageAll's docstring
  // states for its own callers.
  const [movements, total] = await packs.listAndCountStockMovements(
    { card_handle: handle },
    { order: { created_at: 'DESC', id: 'DESC' }, skip: offset, take: limit },
  );

  // Movement rows go out unprojected. VERIFIED NEGATIVE, do not re-hunt:
  // StockMovement has NO bigNumber field (`qty` is model.number()), so unlike
  // the purchase-invoice detail there are no raw_* sidecars to leak;
  // `deleted_at` rides along and is always null (Medusa's list excludes
  // soft-deleted rows).
  res.json({
    item,
    associated: {
      packs: packSlugs.map((slug) => ({
        slug,
        title: titleBySlug.get(slug) ?? slug,
      })),
      rank_rewards: rankRewards,
    },
    movements: { total, offset, limit, rows: movements },
  });
}
