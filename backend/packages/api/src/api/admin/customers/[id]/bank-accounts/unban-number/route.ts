import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = { last4?: unknown; bank_code?: unknown; reason?: unknown };

// POST /admin/customers/:id/bank-accounts/unban-number — support takes one of
// this player's bank numbers off the ban list (owner, 2026-11-04), named by its
// last 4 (and bank when two match). Audited. Other accounts on the number still
// hold it: a customer save stays refused as shared until support adds or
// verifies it.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { last4, bank_code: bankCode, reason } = req.body ?? {};
  if (typeof last4 !== 'string' || !/^[0-9A-Za-z]{4}$/.test(last4)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Give the last 4 of the bank number.',
    );
  }
  if (bankCode !== undefined && bankCode !== null && typeof bankCode !== 'string') {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Pick a bank from the list.');
  }
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    reason.length > 500
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (1–500 chars) is required.',
    );
  }
  const lifted = await req.scope
    .resolve<PacksModuleService>(PACKS_MODULE)
    .liftPayoutAccountBan({
      customerId: req.params.id,
      adminId: req.auth_context.actor_id,
      last4,
      bankCode: bankCode || null,
      reason: reason.trim(),
    });
  res.json({ unbanned: true, ...lifted });
}
