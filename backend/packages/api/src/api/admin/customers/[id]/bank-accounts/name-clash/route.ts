import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import {
  HOLDER_NAME_INVALID_MESSAGE,
  holderNameInvalid,
  normalizeHolderName,
} from '../../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = { holder_name?: unknown; cleared?: unknown; reason?: unknown };

// POST /admin/customers/:id/bank-accounts/name-clash — support checked that this
// player and another account are two real people with one name (owner,
// 2026-11-04). The player may then save a bank under it, although the other
// account saved or was paid under it. Clear each of the two; `cleared: false`
// takes it back. Names already saved are untouched.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { holder_name: raw, cleared, reason } = req.body ?? {};
  const holderName = normalizeHolderName(typeof raw === 'string' ? raw : '');
  if (holderName.length < 2 || holderName.length > 120) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Enter the holder name (2–120 characters).',
    );
  }
  if (holderNameInvalid(holderName)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      HOLDER_NAME_INVALID_MESSAGE,
    );
  }
  if (typeof cleared !== 'boolean') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'cleared must be true or false.',
    );
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
  await req.scope.resolve<PacksModuleService>(PACKS_MODULE).setHolderNameCleared({
    customerId: req.params.id,
    adminId: req.auth_context.actor_id,
    holderName,
    cleared,
    reason: reason.trim(),
  });
  res.json({ cleared });
}
