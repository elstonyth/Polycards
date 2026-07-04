import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';

// POST /admin/packs/:slug/top-hits — set which cards are the pack's Top Hits
// (storefront display only; never touches weights/locks). Body:
// { card_ids: string[] } — the COMPLETE flagged set; every other member row
// is unflagged. Idempotent set semantics, so the admin UI can save per click.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  const body = (req.body ?? {}) as { card_ids?: unknown };
  if (
    !Array.isArray(body.card_ids) ||
    body.card_ids.some((c) => typeof c !== 'string')
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Body must include a `card_ids` string array.',
    );
  }
  const wanted = new Set(body.card_ids as string[]);

  const [pack] = await packs.listPacks({ slug }, { take: 1 });
  if (!pack) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  // Card rows only (reward entries have card_id null and can't be Top Hits).
  const allOdds = await packs.listPackOdds({ pack_id: slug }, { take: 1000 });
  const cardRows = allOdds.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const memberIds = new Set(cardRows.map((o) => o.card_id));
  for (const id of wanted) {
    if (!memberIds.has(id)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Card '${id}' is not in this pack's prize pool.`,
      );
    }
  }

  // Flip only the rows whose flag actually changes.
  const updates = cardRows
    .filter((o) => (o.top_hit === true) !== wanted.has(o.card_id))
    .map((o) => ({ id: o.id, top_hit: wanted.has(o.card_id) }));
  if (updates.length > 0) await packs.updatePackOdds(updates);

  res.json({ top_hits: [...wanted], changed: updates.length });
}
