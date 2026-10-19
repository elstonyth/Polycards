import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  quoteArrivedDeposit,
  settleArrivedDeposit,
} from '../../../../../../modules/packs/settle-arrived';

type Body = { expected_credit?: unknown; reason?: unknown };

/**
 * GET /admin/payments/deposits/:id/settle-arrived — what settling a HELD
 * USDT deposit would credit: ordered vs arrived, and the RM at the row's
 * locked rate, read live from the gateway. Moves nothing.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const quote = await quoteArrivedDeposit(req.scope, req.params.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ quote });
}

/**
 * POST /admin/payments/deposits/:id/settle-arrived — credit it. Body
 * `{ expected_credit, reason }`: the RM the operator was shown (re-read and
 * compared here; 409 with the new quote if the gateway's record moved) and
 * why (required, max 500 characters, kept in the admin action log). Admin-only
 * by the blanket '/admin' guard; rate-limited on the admin-action budget.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const expected = Number(req.body?.expected_credit);
  const reason =
    typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!Number.isFinite(expected) || expected <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'expected_credit (the RM you were shown) is required.',
    );
  }
  if (!reason || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (up to 500 characters) is required.',
    );
  }
  const result = await settleArrivedDeposit(req.scope, {
    depositId: req.params.id,
    expectedCredit: expected,
    adminId: req.auth_context.actor_id,
    reason,
  });
  res.setHeader('Cache-Control', 'no-store');
  // Answered here, not thrown: the error handler swaps every CONFLICT
  // message for a generic idempotency text.
  if (result.kind === 'changed') {
    res.status(409).json({
      type: 'conflict',
      message: `The gateway's record changed since you looked: it now credits RM ${result.quote.credit.toFixed(2)}. Check it and confirm again.`,
      quote: result.quote,
    });
    return;
  }
  res.json({ settled: true, replayed: result.replayed, quote: result.quote });
}
