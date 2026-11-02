import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { creditDepositByAdmin } from '../../../../../../modules/packs/gateway-deposit';

type Body = { reason?: unknown };

/**
 * POST /admin/payments/deposits/:id/credit — Settlement's Credit deposit. Body
 * `{ reason }`: required, max 500 characters, kept in the admin action log.
 * Credits a deposit the gateway confirms was paid, on the sweep's own anchor.
 * See creditDepositByAdmin for what it refuses.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const reason =
    typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (up to 500 characters) is required.',
    );
  }
  res.json(
    await creditDepositByAdmin(req.scope, {
      depositId: req.params.id,
      adminId: req.auth_context.actor_id,
      reason,
    }),
  );
}
