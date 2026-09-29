import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { editGroupOddsSet } from '../../../../../modules/packs/player-groups';

type Body = { odds_set?: unknown };

/**
 * POST /admin/customer-groups/:id/odds-set — change which odds set a player
 * group's members roll.
 *
 * Body: `{ odds_set: 1 | 2 | 3 }`. The DEFAULT-group refusal and the
 * before/after audit row live in editGroupOddsSet.
 *
 * A repo route rather than a metadata write through the native
 * POST /admin/customer-groups/:id, because that route records nothing — and
 * this one changes the odds every member of the group plays. The native
 * update refuses the key (rejectGroupOddsSetUpdate), so this is its only
 * writer. Admin routes are framework-auto-protected.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.body?.odds_set;
  if (raw !== 1 && raw !== 2 && raw !== 3) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'odds_set must be 1, 2 or 3.',
    );
  }
  const group = await editGroupOddsSet(req.scope, {
    groupId: req.params.id,
    oddsSet: raw,
    adminId: req.auth_context.actor_id,
  });
  res.json({
    customer_group: {
      id: group.id,
      name: group.name,
      metadata: group.metadata ?? null,
    },
  });
}
