import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { configAuditRow } from '../../../../../modules/packs/config-audit';
import { clearPackDetailCache } from '../../../../store/packs/[slug]/route';
import { pageAll } from '../../../../utils/page-all';

// POST /admin/packs/:slug/top-hits — set the pack's Top Hits IN DISPLAY ORDER
// (storefront display only; never touches weights/locks). Body:
// { card_ids: string[] } — the COMPLETE ordered list: index 0 renders first
// (leftmost, order 1), index 1 second, and so on; every member row not listed
// loses its order (not a Top Hit). Idempotent list semantics, so the admin UI
// can save per edit.
export async function POST(
  req: AuthenticatedMedusaRequest,
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
  const ordered = body.card_ids as string[];
  if (new Set(ordered).size !== ordered.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`card_ids` must not contain duplicates.',
    );
  }
  const wanted = new Set(ordered);

  const [pack] = await packs.listPacks({ slug }, { take: 1 });
  if (!pack) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  // Card rows only (reward entries have card_id null and can't be Top Hits).
  // PAGED so Top Hits can reference any member of a 2000+ card pool.
  const allOdds = await pageAll((opts) =>
    packs.listPackOdds({ pack_id: slug }, opts),
  );
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

  // Write only the rows whose order actually changes. Order = 1-based index
  // in the submitted list; null for everything else.
  const orderOf = new Map(ordered.map((id, i) => [id, i + 1]));
  const changed = cardRows.filter(
    (o) => (o.top_hit_order ?? null) !== (orderOf.get(o.card_id) ?? null),
  );
  const updates = changed.map((o) => ({
    id: o.id,
    top_hit_order: orderOf.get(o.card_id) ?? null,
  }));
  if (updates.length > 0) {
    await packs.updatePackOdds(updates);
    // Top Hit order is storefront-detail display data — reflect it now.
    clearPackDetailCache();
    // Recorded after the write (a plain route write, no workflow to roll it
    // back): a failed audit surfaces as a 500 the operator sees, never a
    // silent change — same stance as editGroupPolicy.
    await packs.createAdminActionAudits([
      configAuditRow({
        adminId: req.auth_context.actor_id,
        entityType: 'pack',
        entityId: slug,
        action: 'edit_top_hits',
        before: {
          top_hits: Object.fromEntries(
            changed.map((o) => [o.card_id, o.top_hit_order ?? null]),
          ),
        },
        after: {
          top_hits: Object.fromEntries(
            changed.map((o) => [o.card_id, orderOf.get(o.card_id) ?? null]),
          ),
        },
      }),
    ]);
  }

  res.json({ top_hits: ordered, changed: updates.length });
}
