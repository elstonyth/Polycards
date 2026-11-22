import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { creditFromAdjustmentEntry } from '../../../../../../modules/packs/deposit-adjustment-entry';
import type { CreditFromEntryResult } from './types';

type Body = { ref?: unknown; reason?: unknown };

/**
 * POST /admin/payments/deposits/:id/credit-from-entry — Settlement's Credit
 * from gateway entry. Body `{ ref, reason }`: `ref` is the gateway's Merchant
 * Reference ID for the manual entry that booked what arrived (GlobePay365:
 * MD…), `reason` is required, max 500 characters, kept in the admin action log.
 * Credits the entry's amount through the row's FX lock and links the entry.
 * See creditFromAdjustmentEntry for what it refuses.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse<CreditFromEntryResult>,
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
    await creditFromAdjustmentEntry(req.scope, {
      depositId: req.params.id,
      ref,
      adminId: req.auth_context.actor_id,
      reason,
    }),
  );
}
