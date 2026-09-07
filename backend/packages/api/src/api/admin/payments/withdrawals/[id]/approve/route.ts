import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { submitHeldWithdrawal } from '../../../../../../modules/packs/gateway-withdrawal';
import { payerIpOf } from '../../../../../utils/payer-ip';

// POST /admin/payments/withdrawals/:id/approve — release a HELD payout to the
// gateway. Together with ./deny this is the only way a held row leaves that
// state (plan 094); the sweep never selects one.
//
// The decision, the claim, the submit and the refund-on-refusal all live in
// submitHeldWithdrawal (modules/packs/gateway-withdrawal.ts), beside
// startWithdrawal — the customer-initiated twin whose step 3 this resumes.
// What is left here is the request: who is asking (the framework's blanket
// '/admin' auth guard puts the actor on req.auth_context), from where, about
// which row.
//
// Rate-limited on the shared admin-action budget (src/api/middlewares.ts).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const result = await submitHeldWithdrawal(req.scope, {
    withdrawalId: req.params.id,
    adminId: req.auth_context.actor_id,
    // The ADMIN's request IP, not the customer's — see the operation's own
    // note on why that is still the un-forgeable value the gateway wants.
    payerIp: payerIpOf(req),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}
