import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import { sendSavedAccountRemovedNotice } from '../../../../../../modules/packs/saved-account-notice';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = { account_id?: unknown; reason?: unknown };

// POST /admin/customers/:id/bank-accounts/remove — support takes a tied bank
// account off a player's list, the only way it comes off (ADR 0015). The player
// can then save another one. Their paid-out rows stay, so the number still counts
// as theirs for anyone else who tries to use it.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const accountId = req.body?.account_id;
  const reason = req.body?.reason;
  if (typeof accountId !== 'string' || accountId === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Say which saved account to remove.',
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
  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const removed = await packs.removeSavedBankAccount({
    customerId,
    adminId: req.auth_context.actor_id,
    accountId,
    reason: reason.trim(),
  });
  // Removal is a security event whoever does it: the owner hears about it. After
  // commit, and it never fails the removal (the helper swallows its own errors).
  if (removed) {
    await sendSavedAccountRemovedNotice(req.scope, {
      customerId,
      accountId: removed.id,
      bankName: removed.bankName,
      accountNumber: removed.accountNumber,
      removedAt: new Date().toISOString(),
    });
  }
  res.json({ removed: removed !== null });
}
