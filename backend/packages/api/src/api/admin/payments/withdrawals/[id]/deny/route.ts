import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { denyHeldWithdrawal } from '../../../../../../modules/packs/gateway-withdrawal';

// POST /admin/payments/withdrawals/:id/deny — refuse a HELD payout and hand
// the money back. The other exit from 'held' (plan 094); ./approve is the one
// that pays.
//
// The claim-before-refund ordering, the never-debited branch and the
// re-runnability that makes the crash window recoverable all live in
// denyHeldWithdrawal (modules/packs/gateway-withdrawal.ts), beside the refund
// helper whose idempotency anchor they depend on.
//
// Admin-only by the framework's blanket '/admin' auth guard; rate-limited on
// the shared admin-action budget (src/api/middlewares.ts).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const result = await denyHeldWithdrawal(req.scope, {
    withdrawalId: req.params.id,
    adminId: req.auth_context.actor_id,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}
