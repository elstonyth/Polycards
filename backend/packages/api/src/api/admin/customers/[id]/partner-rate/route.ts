import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { assertNotInPartnerGroup } from '../../../../../modules/packs/group-policy';
import { reqReason } from '../../../rewards-settings/validate';

// POST /admin/customers/:id/partner-rate { rate_bp, reason } — flag (or, with
// rate_bp null, unflag) a partner account. Bounds enforcement and the audit
// row live in setPartnerRate.
export async function POST(
  req: AuthenticatedMedusaRequest<{ rate_bp?: unknown; reason?: unknown }>,
  res: MedusaResponse,
): Promise<void> {
  const rateBp = req.body?.rate_bp ?? null;
  if (rateBp !== null && typeof rateBp !== 'number') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'rate_bp must be a number or null.',
    );
  }
  // Group config beats the manual flag (spec 2026-09-09): a member of a
  // partner group is refused here, with the message the admin card also shows.
  await assertNotInPartnerGroup(req.scope, req.params.id);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.setPartnerRate({
    customerId: req.params.id,
    rateBp,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ ok: true });
}
