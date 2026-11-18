import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { linkAdjustmentEntry } from '../../../../../../modules/packs/deposit-adjustment-entry';
import type { LinkAdjustmentEntryResult } from './types';

type Body = { ref?: unknown; reason?: unknown };

/**
 * POST /admin/payments/deposits/:id/adjustment-entry — Settlement's Link
 * gateway entry. Body `{ ref, reason }`: `ref` is the gateway's Merchant
 * Reference ID for the manual entry that booked a short payment (GlobePay365:
 * MD…), `reason` is required, max 500 characters, kept in the admin action log.
 * Moves no money. See linkAdjustmentEntry for what it refuses.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse<LinkAdjustmentEntryResult>,
): Promise<void> {
  const reason =
    typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (up to 500 characters) is required.',
    );
  }
  const ref = typeof req.body?.ref === 'string' ? req.body.ref : '';
  res.json(
    await linkAdjustmentEntry(req.scope, {
      depositId: req.params.id,
      ref,
      adminId: req.auth_context.actor_id,
      reason,
    }),
  );
}
