import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IUserModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

type Body = { kind?: unknown; id?: unknown; note?: unknown; reason?: unknown };

/**
 * POST /admin/payments/audit/acknowledge — Settlement's Acknowledge
 * (2026-10-15). Body `{ kind: 'deposit'|'withdrawal', id, note, reason }`:
 * the finding's row, the note the operator saw, and why it needs no more
 * action (required, max 500 characters, kept in the admin action log). The
 * finding then stops counting until the audit writes a different note.
 * 409 when the note has changed since the page loaded.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { kind, id, note } = req.body ?? {};
  const reason =
    typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (kind !== 'deposit' && kind !== 'withdrawal') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'kind must be deposit or withdrawal.',
    );
  }
  if (typeof id !== 'string' || !id || typeof note !== 'string' || !note) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'id and note are required.',
    );
  }
  if (!reason || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (up to 500 characters) is required.',
    );
  }
  const adminId = req.auth_context.actor_id;
  const users = req.scope.resolve<IUserModuleService>(Modules.USER);
  const admin = await users.retrieveUser(adminId).catch(() => null);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const outcome = await packs.acknowledgeAuditFinding({
    kind,
    id,
    note,
    adminId,
    adminEmail: admin?.email ?? adminId,
    reason,
  });
  if (outcome === 'not_found') {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No such payment.');
  }
  // Answered here, not thrown: the error handler swaps every CONFLICT
  // message for a generic idempotency text.
  if (outcome === 'changed') {
    res.status(409).json({
      type: 'conflict',
      message:
        'The gateway check changed this finding since the page loaded. Reload and look again.',
    });
    return;
  }
  res.json({ acknowledged: true });
}
