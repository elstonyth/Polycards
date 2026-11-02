import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { editGroupDraftAccess } from '../../../../../modules/packs/player-groups';
import { reqReason } from '../../../rewards-settings/validate';

type Body = { sees_drafts?: unknown; reason?: unknown };

/**
 * POST /admin/customer-groups/:id/draft-access — whether a player group's members
 * can see Draft packs and spin Draft ticket packs. Body: `{ sees_drafts: boolean,
 * reason: string }`. The DEFAULT-group refusal and the audit row live in
 * editGroupDraftAccess.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const body = req.body ?? {};
  if (typeof body.sees_drafts !== 'boolean') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'sees_drafts must be a boolean.',
    );
  }
  const group = await editGroupDraftAccess(req.scope, {
    groupId: req.params.id,
    seesDrafts: body.sees_drafts,
    adminId: req.auth_context.actor_id,
    reason: reqReason(body),
  });
  res.json({
    customer_group: {
      id: group.id,
      name: group.name,
      metadata: group.metadata ?? null,
    },
  });
}
